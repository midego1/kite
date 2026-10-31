import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messageAttachments, messages } from "@/db/schema";
import { sha256Hex } from "@/lib/aws/sigv4";
import { missingColumnFromError } from "@/lib/auth/user-lookup-utils";
import { createLogger } from "@/lib/logger.mjs";
import { attachmentObjectKey } from "./attachment-name-utils";
import {
	findAttachmentSource,
	isAttachmentRawIndexEnabled,
	isRawAttachmentKey,
	isRawBackedMessage,
	locateAttachmentParts,
} from "./attachment-storage-utils";
import { MimeLimitError, parseRawMime } from "./parse";
import type { RepairableAttachment } from "./attachment-storage-types";

const log = createLogger("attachments");

/**
 * Lazy repair (`docs/specs/attachments-once.md` §5.2 and §7): an attachment whose stored bytes cannot be served is
 * rebuilt from postal-mime's decoding of its message's raw, which is never rewritten. Only `attachment-storage.ts`
 * calls it, after a read came back empty or wrong; nothing is ever served that was not checked against the raw.
 */

/** A row and its message, read without the storage columns so it works on a database whose schema is behind. */
async function loadRepairable(env: CloudflareEnv, attachmentId: string): Promise<RepairableAttachment | null> {
	const [row] = await getDb(env)
		.select({
			id: messageAttachments.id,
			messageId: messageAttachments.messageId,
			filename: messageAttachments.filename,
			contentType: messageAttachments.contentType,
			size: messageAttachments.size,
			contentId: messageAttachments.contentId,
			r2Key: messageAttachments.r2Key,
			rawKey: messages.rawR2Key,
			status: messages.status,
		})
		.from(messageAttachments)
		.innerJoin(messages, eq(messageAttachments.messageId, messages.id))
		.where(eq(messageAttachments.id, attachmentId))
		.limit(1);
	return row ?? null;
}

/** The raw message and the bytes postal-mime decodes for `row` from it; null when the raw is gone or ambiguous. */
async function sourceFromRaw(
	env: CloudflareEnv,
	row: RepairableAttachment,
): Promise<{ raw: ArrayBuffer; content: ArrayBuffer } | null> {
	if (!row.rawKey) return null;
	const object = await env.BUCKET.get(row.rawKey);
	if (!object) return null;
	const raw = await object.arrayBuffer();
	try {
		const parsed = await parseRawMime(raw);
		const source = findAttachmentSource(row, parsed.attachments);
		return source ? { raw, content: source.content } : null;
	} catch (error) {
		if (error instanceof MimeLimitError) return null;
		throw error;
	}
}

/** Runs a conditional UPDATE; how many rows it changed, or null before migration 0088. */
async function changedRows(env: CloudflareEnv, sql: string, params: unknown[]): Promise<number | null> {
	try {
		const result = await env.DB.prepare(sql)
			.bind(...params)
			.run();
		return Number(result.meta?.changes ?? 0);
	} catch (error) {
		if (missingColumnFromError(error)) return null;
		throw error;
	}
}

/**
 * Turns `row` into a 'raw' row when its bytes are verified in the raw. False when they are not, the switch is off, the
 * schema is behind, or another request changed the row first.
 */
async function convertToRaw(
	env: CloudflareEnv,
	row: RepairableAttachment,
	source: { raw: ArrayBuffer; content: ArrayBuffer },
): Promise<boolean> {
	if (!isAttachmentRawIndexEnabled(env.ATTACHMENT_RAW_INDEX)) return false;
	const part = locateAttachmentParts(source.raw, [source]).get(0);
	if (!part) return false;
	const changed = await changedRows(
		env,
		`UPDATE message_attachments SET storage = 'raw', r2_key = 'raw:' || id, raw_offset = ?, raw_length = ?,
			transfer_encoding = ?, sha256 = ? WHERE id = ? AND storage = 'object' AND r2_key = ?`,
		[part.offset, part.length, part.encoding, await sha256Hex(source.content), row.id, row.r2Key],
	);
	return changed === 1;
}

function putObject(env: CloudflareEnv, key: string, row: RepairableAttachment, content: ArrayBuffer) {
	return env.BUCKET.put(key, content, {
		httpMetadata: { contentType: row.contentType },
		customMetadata: { filename: row.filename, messageId: row.messageId },
	});
}

/**
 * Repairs an 'object' row whose object is missing (a backup from before a reclaim restored over it): it becomes a
 * 'raw' row when the raw verifies it, and otherwise gets its object back under its own key. Returns how the row is
 * stored now, or null when it cannot be repaired.
 */
export async function repairMissingObject(env: CloudflareEnv, attachmentId: string): Promise<"raw" | "object" | null> {
	const row = await loadRepairable(env, attachmentId);
	if (!row || isRawAttachmentKey(row.r2Key) || !isRawBackedMessage(row)) return null;
	const source = await sourceFromRaw(env, row);
	if (!source) {
		log.warn("attachment.repair_failed", { attachmentId, messageId: row.messageId });
		return null;
	}
	if (await convertToRaw(env, row, source)) {
		log.info("attachment.repaired", { attachmentId, messageId: row.messageId, storage: "raw" });
		return "raw";
	}
	await putObject(env, row.r2Key, row, source.content);
	log.info("attachment.repaired", { attachmentId, messageId: row.messageId, storage: "object" });
	return "object";
}

/**
 * Materializes a 'raw' row whose range no longer decodes to its recorded bytes: postal-mime's decoding of the raw is
 * written as an object of its own when it has the recorded size and digest, and the row is repointed at it. Returns
 * those bytes, or null when nothing matching can be found (never anything unverified).
 */
export async function materializeMismatchedRaw(
	env: CloudflareEnv,
	attachmentId: string,
	expected: { size: number; sha256: string | null },
): Promise<ArrayBuffer | null> {
	const row = await loadRepairable(env, attachmentId);
	if (!row || !isRawAttachmentKey(row.r2Key)) return null;
	const source = await sourceFromRaw(env, row);
	const digest = source ? await sha256Hex(source.content) : null;
	if (!source || source.content.byteLength !== expected.size || (expected.sha256 && digest !== expected.sha256)) {
		log.error("attachment.raw_mismatch", { attachmentId, messageId: row.messageId });
		return null;
	}
	const key = attachmentObjectKey(row.messageId, row.id);
	await putObject(env, key, row, source.content);
	const changed = await changedRows(
		env,
		`UPDATE message_attachments SET storage = 'object', r2_key = ?, raw_offset = NULL, raw_length = NULL,
			transfer_encoding = NULL WHERE id = ? AND storage = 'raw'`,
		[key, row.id],
	);
	// Another read may have repointed the row at this same key first; the object is only ours to remove otherwise.
	if (changed !== 1 && (await loadRepairable(env, attachmentId))?.r2Key !== key) await env.BUCKET.delete(key);
	log.info("attachment.repaired", { attachmentId, messageId: row.messageId, storage: "object" });
	return source.content;
}
