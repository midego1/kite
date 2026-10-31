import { and, asc, eq, gt } from "drizzle-orm";
import { getDb } from "@/db";
import { messageAttachments } from "@/db/schema";
import { sha256Hex } from "@/lib/aws/sigv4";
import { createLogger } from "@/lib/logger.mjs";
import { attachmentObjectKey } from "./attachment-name-utils";
import { repairMissingObject } from "./attachment-repair";
import { deleteUnreferencedObjects, readAttachmentBytes } from "./attachment-storage";
import { ATTACHMENT_OBJECT_ROWS_SQL, locateAttachmentParts, rawBackedMessagesSql } from "./attachment-storage-utils";
import {
	BATCH_BUDGET,
	BATCH_ROWS,
	emptyBatch,
	materializeCost,
	reclaimCost,
	takeWithinBudget,
	unshareCost,
} from "./attachment-storage-jobs-utils";
import type { AttachmentStorageBatchResult } from "./attachment-storage-jobs-types";
import type { RawPartLocation } from "./attachment-storage-types";

const log = createLogger("attachments");

/**
 * One batch of the admin attachment storage job (`docs/specs/attachments-once.md` §5.5). Every change is a conditional
 * update that names the state it expects, so a batch that runs twice, races a delivery, a forward or a delete, or dies
 * half way changes nothing it should not; an object it wrote for an update that then matched nothing is removed again.
 * Next to `attachment-storage.ts` it is the only code that reads an attachment row's object by its key.
 */

/** When the batch stops starting items, and what runs after each one (the development crash hook). */
export interface BatchContext {
	deadline: number;
	afterItem?: () => void;
}

type ObjectRow = { id: string; messageId: string; r2Key: string; filename: string; contentType: string; size: number };

const seconds = (ms: number) => Math.floor(ms / 1000);

function describe(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

async function changes(env: CloudflareEnv, sql: string, params: unknown[]): Promise<number> {
	const result = await env.DB.prepare(sql)
		.bind(...params)
		.run();
	return Number(result.meta?.changes ?? 0);
}

function putAttachmentObject(env: CloudflareEnv, key: string, row: ObjectRow, content: ArrayBuffer) {
	return env.BUCKET.put(key, content, {
		httpMetadata: { contentType: row.contentType },
		customMetadata: { filename: row.filename, messageId: row.messageId },
	});
}

/** The key a row names now; null when the row is gone. */
async function currentKey(env: CloudflareEnv, id: string): Promise<string | null> {
	const [row] = await getDb(env)
		.select({ r2Key: messageAttachments.r2Key })
		.from(messageAttachments)
		.where(eq(messageAttachments.id, id))
		.limit(1);
	return row?.r2Key ?? null;
}

/** Removes an object this batch wrote for an update that matched nothing, unless the row names it after all. */
async function dropUnclaimedCopy(env: CloudflareEnv, id: string, key: string): Promise<boolean> {
	if ((await currentKey(env, id)) === key) return true;
	await env.BUCKET.delete(key);
	return false;
}

// ---------------------------------------------------------------------------------------------------------------
// Reclaim: 'object' rows of received and imported mail become 'raw' rows where the raw message holds their bytes.

type ReclaimMessage = { messageId: string; rawKey: string; rows: number; bytes: number };
type ReclaimRow = ObjectRow & { contentId: string | null };

/** Messages after `cursor` with 'object' rows reclaim has not looked at, in id order. */
async function reclaimCandidates(env: CloudflareEnv, cursor: string | null): Promise<ReclaimMessage[]> {
	const { results } = await env.DB.prepare(
		`SELECT a.message_id AS messageId, m.raw_r2_key AS rawKey, count(*) AS rows, coalesce(sum(a.size), 0) AS bytes FROM message_attachments a JOIN messages m ON m.id = a.message_id WHERE ${ATTACHMENT_OBJECT_ROWS_SQL} AND a.storage = 'object' AND a.storage_checked_at IS NULL AND ${rawBackedMessagesSql("m")} AND a.message_id > ? GROUP BY a.message_id ORDER BY a.message_id LIMIT ?`,
	)
		.bind(cursor ?? "", BATCH_BUDGET.items)
		.all<ReclaimMessage>();
	return results ?? [];
}

async function reclaimRows(env: CloudflareEnv, messageId: string): Promise<ReclaimRow[]> {
	const { results } = await env.DB.prepare(
		`SELECT id, message_id AS messageId, r2_key AS r2Key, filename, content_type AS contentType, size, content_id AS contentId FROM message_attachments WHERE message_id = ? AND storage = 'object' AND storage_checked_at IS NULL AND ${ATTACHMENT_OBJECT_ROWS_SQL} ORDER BY rowid`,
	)
		.bind(messageId)
		.all<ReclaimRow>();
	return results ?? [];
}

/** Marks rows reclaim looked at and left as they were, so the next run does not read them again. */
async function markChecked(env: CloudflareEnv, ids: string[], now: number): Promise<void> {
	if (!ids.length) return;
	await changes(
		env,
		"UPDATE message_attachments SET storage_checked_at = ? WHERE storage = 'object' AND id IN (SELECT value FROM json_each(?))",
		[seconds(now), JSON.stringify(ids)],
	);
}

/** The 'raw' row an 'object' row becomes, only while it still names the object whose bytes were verified. */
async function convertRow(
	env: CloudflareEnv,
	row: ReclaimRow,
	part: RawPartLocation,
	content: ArrayBuffer,
	now: number,
): Promise<boolean> {
	const changed = await changes(
		env,
		`UPDATE message_attachments SET storage = 'raw', r2_key = 'raw:' || id, raw_offset = ?, raw_length = ?,
			transfer_encoding = ?, sha256 = ?, storage_checked_at = ? WHERE id = ? AND storage = 'object' AND r2_key = ?`,
		[part.offset, part.length, part.encoding, await sha256Hex(content), seconds(now), row.id, row.r2Key],
	);
	return changed === 1;
}

/** Where each verified row's bytes are in `raw`; a raw message the index cannot read matches nothing. */
function locate(raw: ArrayBuffer, present: { content: ArrayBuffer }[]): Map<number, RawPartLocation> {
	try {
		return locateAttachmentParts(raw, present);
	} catch {
		return new Map();
	}
}

/**
 * One message: its raw message once, each row's object, and a conditional update per row whose bytes the raw holds;
 * then the objects no row names any more (a forward made earlier keeps its shared object). A row whose object is
 * gone goes through the lazy repair, which turns it into a 'raw' row or puts its object back.
 */
async function reclaimMessage(env: CloudflareEnv, message: ReclaimMessage, result: AttachmentStorageBatchResult) {
	const now = Date.now();
	const rows = await reclaimRows(env, message.messageId);
	const raw = await env.BUCKET.get(message.rawKey);
	result.done += rows.length;
	if (!raw) {
		await markChecked(
			env,
			rows.map((row) => row.id),
			now,
		);
		result.failed += rows.length;
		return;
	}
	const rawBytes = await raw.arrayBuffer();
	const present: { row: ReclaimRow; content: ArrayBuffer }[] = [];
	const leftAlone: string[] = [];
	for (const row of rows) {
		const object = await env.BUCKET.get(row.r2Key);
		if (object) {
			present.push({ row, content: await object.arrayBuffer() });
			continue;
		}
		const repaired = await repairMissingObject(env, row.id);
		if (repaired === "raw") result.converted += 1;
		else leftAlone.push(row.id);
		if (repaired === "object") result.unmatched += 1;
		if (!repaired) result.failed += 1;
	}
	const located = locate(rawBytes, present);
	const freed: string[] = [];
	for (const [index, { row, content }] of present.entries()) {
		const part = located.get(index);
		if (part && (await convertRow(env, row, part, content, now))) {
			freed.push(row.r2Key);
			result.converted += 1;
		} else {
			leftAlone.push(row.id);
			result.unmatched += 1;
		}
	}
	await markChecked(env, leftAlone, now);
	if (freed.length) await deleteUnreferencedObjects(env, { attachmentKeys: freed });
}

export async function runReclaimBatch(
	env: CloudflareEnv,
	cursor: string | null,
	context: BatchContext,
): Promise<AttachmentStorageBatchResult> {
	const candidates = await reclaimCandidates(env, cursor);
	const batch = takeWithinBudget(candidates, reclaimCost);
	const result = emptyBatch(cursor);
	for (const message of batch) {
		if (result.cursor !== cursor && Date.now() >= context.deadline) return result;
		try {
			await reclaimMessage(env, message, result);
		} catch (error) {
			result.failed += 1;
			result.lastError = describe(error);
			log.warn("attachment.reclaim_failed", { messageId: message.messageId, error });
		}
		result.cursor = message.messageId;
		context.afterItem?.();
	}
	result.exhausted = candidates.length < BATCH_BUDGET.items && batch.length === candidates.length;
	return result;
}

// ---------------------------------------------------------------------------------------------------------------
// Materialize: every 'raw' row gets an object of its own again.

async function rawRows(env: CloudflareEnv, cursor: string | null): Promise<ObjectRow[]> {
	return getDb(env)
		.select({
			id: messageAttachments.id,
			messageId: messageAttachments.messageId,
			r2Key: messageAttachments.r2Key,
			filename: messageAttachments.filename,
			contentType: messageAttachments.contentType,
			size: messageAttachments.size,
		})
		.from(messageAttachments)
		.where(and(eq(messageAttachments.storage, "raw"), gt(messageAttachments.id, cursor ?? "")))
		.orderBy(asc(messageAttachments.id))
		.limit(BATCH_ROWS);
}

/**
 * One 'raw' row: its verified bytes (the accessor checks the recorded digest), written under the row's own key, then
 * the row repointed while it is still 'raw'. The lazy repair may have materialized it to that same key meanwhile.
 */
async function materializeRow(env: CloudflareEnv, row: ObjectRow, result: AttachmentStorageBatchResult) {
	const bytes = await readAttachmentBytes(env, row);
	if (!bytes) {
		result.failed += 1;
		result.lastError = "A file's raw message is missing, so it was left as it was";
		return;
	}
	const key = attachmentObjectKey(row.messageId, row.id);
	await putAttachmentObject(env, key, row, bytes);
	const changed = await changes(
		env,
		`UPDATE message_attachments SET storage = 'object', r2_key = ?, raw_offset = NULL, raw_length = NULL,
			transfer_encoding = NULL, storage_checked_at = NULL WHERE id = ? AND storage = 'raw'`,
		[key, row.id],
	);
	if (changed === 1 || (await dropUnclaimedCopy(env, row.id, key))) result.converted += 1;
}

export async function runMaterializeBatch(
	env: CloudflareEnv,
	cursor: string | null,
	context: BatchContext,
): Promise<AttachmentStorageBatchResult> {
	return runRowBatch(await rawRows(env, cursor), cursor, context, materializeCost, (row, result) =>
		materializeRow(env, row, result),
	);
}

// ---------------------------------------------------------------------------------------------------------------
// Unshare: every 'object' row that names an object an older row also names gets a copy of its own.

/** Rows after `cursor` naming an object that an older row names too; the oldest keeps it. */
async function sharedRows(env: CloudflareEnv, cursor: string | null): Promise<ObjectRow[]> {
	const { results } = await env.DB.prepare(
		`SELECT a.id, a.message_id AS messageId, a.r2_key AS r2Key, a.filename, a.content_type AS contentType, a.size FROM message_attachments a WHERE ${ATTACHMENT_OBJECT_ROWS_SQL} AND a.id > ?
			AND EXISTS (SELECT 1 FROM message_attachments b WHERE b.r2_key = a.r2_key AND b.rowid < a.rowid AND ${ATTACHMENT_OBJECT_ROWS_SQL})
			ORDER BY a.id LIMIT ?`,
	)
		.bind(cursor ?? "", BATCH_ROWS)
		.all<ObjectRow>();
	return results ?? [];
}

/** One shared row: a copy under its own key, then the row repointed while it still names the shared object. */
async function unshareRow(env: CloudflareEnv, row: ObjectRow, result: AttachmentStorageBatchResult) {
	const key = attachmentObjectKey(row.messageId, row.id);
	if (key === row.r2Key) return;
	const object = await env.BUCKET.get(row.r2Key);
	if (!object) {
		result.failed += 1;
		result.lastError = "A shared file's object is missing, so it could not be copied";
		return;
	}
	await env.BUCKET.put(key, await object.arrayBuffer(), {
		httpMetadata: object.httpMetadata ?? { contentType: row.contentType },
		customMetadata: { ...object.customMetadata, filename: row.filename, messageId: row.messageId },
	});
	const changed = await changes(env, "UPDATE message_attachments SET r2_key = ? WHERE id = ? AND r2_key = ?", [
		key,
		row.id,
		row.r2Key,
	]);
	if (changed === 1 || (await dropUnclaimedCopy(env, row.id, key))) result.unshared += 1;
}

export async function runUnshareBatch(
	env: CloudflareEnv,
	cursor: string | null,
	context: BatchContext,
): Promise<AttachmentStorageBatchResult> {
	return runRowBatch(await sharedRows(env, cursor), cursor, context, unshareCost, (row, result) =>
		unshareRow(env, row, result),
	);
}

/** Runs rows in id order within the budget and the deadline; a row that throws is counted and skipped. */
async function runRowBatch(
	rows: ObjectRow[],
	cursor: string | null,
	context: BatchContext,
	cost: (row: ObjectRow) => { bytes: number; operations: number },
	run: (row: ObjectRow, result: AttachmentStorageBatchResult) => Promise<void>,
): Promise<AttachmentStorageBatchResult> {
	const batch = takeWithinBudget(rows, cost);
	const result = emptyBatch(cursor);
	for (const row of batch) {
		if (result.cursor !== cursor && Date.now() >= context.deadline) return result;
		try {
			await run(row, result);
		} catch (error) {
			result.failed += 1;
			result.lastError = describe(error);
			log.warn("attachment.storage_job_row_failed", { attachmentId: row.id, messageId: row.messageId, error });
		}
		result.done += 1;
		result.cursor = row.id;
		context.afterItem?.();
	}
	result.exhausted = rows.length < BATCH_ROWS && batch.length === rows.length;
	return result;
}
