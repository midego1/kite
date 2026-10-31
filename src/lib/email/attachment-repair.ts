import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messageAttachments, messages } from "@/db/schema";
import { sha256Hex } from "@/lib/aws/sigv4";
import { missingColumnFromError } from "@/lib/auth/user-lookup-utils";
import { createLogger } from "@/lib/logger.mjs";
import { newId } from "@/lib/ids";
import { freshAttachmentObjectKey } from "./attachment-name-utils";
import {
	ATTACHMENT_OBJECT_ROWS_SQL,
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

const REPAIRABLE_COLUMNS = {
	id: messageAttachments.id,
	messageId: messageAttachments.messageId,
	filename: messageAttachments.filename,
	contentType: messageAttachments.contentType,
	size: messageAttachments.size,
	contentId: messageAttachments.contentId,
	r2Key: messageAttachments.r2Key,
	rawKey: messages.rawR2Key,
	status: messages.status,
};

function selectRepairable(env: CloudflareEnv, attachmentId: string, withDigest: boolean) {
	return getDb(env)
		.select(withDigest ? { ...REPAIRABLE_COLUMNS, sha256: messageAttachments.sha256 } : REPAIRABLE_COLUMNS)
		.from(messageAttachments)
		.innerJoin(messages, eq(messageAttachments.messageId, messages.id))
		.where(eq(messageAttachments.id, attachmentId))
		.limit(1);
}

/** A row, its recorded digest and its message; the digest reads as null before migration 0088 adds it. */
async function loadRepairable(env: CloudflareEnv, attachmentId: string): Promise<RepairableAttachment | null> {
	try {
		const [row] = await selectRepairable(env, attachmentId, true);
		return row ? { sha256: null, ...row } : null;
	} catch (error) {
		if (!missingColumnFromError(error)) throw error;
		const [row] = await selectRepairable(env, attachmentId, false);
		return row ? { ...row, sha256: null } : null;
	}
}

/** Whether any row names `key`: a key no row names never gains a reference again (invariant 5), so it may go. */
async function isKeyNamed(env: CloudflareEnv, key: string): Promise<boolean> {
	const [row] = await getDb(env)
		.select({ id: messageAttachments.id })
		.from(messageAttachments)
		.where(eq(messageAttachments.r2Key, key))
		.limit(1);
	return !!row;
}

/** How long an attachment that could not be repaired is not tried again in this isolate. */
const UNREPAIRABLE_TTL_MS = 60_000;
const UNREPAIRABLE_MAX = 1000;
const unrepairable = new Map<string, number>();

function recentlyUnrepairable(attachmentId: string): boolean {
	const until = unrepairable.get(attachmentId);
	if (until && until > Date.now()) return true;
	unrepairable.delete(attachmentId);
	return false;
}

function markUnrepairable(attachmentId: string, messageId: string, reason: string): null {
	if (unrepairable.size >= UNREPAIRABLE_MAX) unrepairable.clear();
	unrepairable.set(attachmentId, Date.now() + UNREPAIRABLE_TTL_MS);
	log.warn("attachment.repair_failed", { attachmentId, messageId, reason });
	return null;
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
 * Turns `row` into a 'raw' row when its bytes are verified in the raw and no other row names its key: a forward or a
 * send sharing the missing object still needs it put back. The check and the change are one statement, so a share
 * that lands meanwhile keeps the row an object. `converted`, `unchanged` when the UPDATE matched nothing (shared,
 * or another request changed the row first), or `ineligible` (the switch is off, the bytes are not in the raw, or
 * the schema is behind).
 */
async function convertToRaw(
	env: CloudflareEnv,
	row: RepairableAttachment,
	source: { raw: ArrayBuffer; content: ArrayBuffer },
	sha256: string,
): Promise<"converted" | "unchanged" | "ineligible"> {
	if (!isAttachmentRawIndexEnabled(env.ATTACHMENT_RAW_INDEX)) return "ineligible";
	const part = locateAttachmentParts(source.raw, [source]).get(0);
	if (!part) return "ineligible";
	const changed = await changedRows(
		env,
		`UPDATE message_attachments SET storage = 'raw', r2_key = 'raw:' || id, raw_offset = ?, raw_length = ?,
			transfer_encoding = ?, sha256 = ? WHERE id = ? AND storage = 'object' AND r2_key = ?
			AND NOT EXISTS (SELECT 1 FROM message_attachments AS other WHERE other.r2_key = ? AND other.id <> ? AND ${ATTACHMENT_OBJECT_ROWS_SQL})`,
		[part.offset, part.length, part.encoding, sha256, row.id, row.r2Key, row.r2Key, row.id],
	);
	if (changed === null) return "ineligible";
	return changed === 1 ? "converted" : "unchanged";
}

function putObject(env: CloudflareEnv, key: string, row: RepairableAttachment, content: ArrayBuffer) {
	return env.BUCKET.put(key, content, {
		httpMetadata: { contentType: row.contentType },
		customMetadata: { filename: row.filename, messageId: row.messageId },
	});
}

/**
 * Puts a missing object back under its key, while `row` still names it; a row deleted or repointed meanwhile leaves
 * nothing behind. Returns how the row is stored now.
 */
async function putBack(
	env: CloudflareEnv,
	row: RepairableAttachment,
	content: ArrayBuffer,
	reread: boolean,
): Promise<"raw" | "object" | null> {
	const current = reread ? await loadRepairable(env, row.id) : row;
	if (current && isRawAttachmentKey(current.r2Key)) return "raw";
	if (!current || current.r2Key !== row.r2Key) return null;
	await putObject(env, row.r2Key, row, content);
	if (!(await isKeyNamed(env, row.r2Key))) {
		await env.BUCKET.delete(row.r2Key);
		return null;
	}
	log.info("attachment.repaired", { attachmentId: row.id, messageId: row.messageId, storage: "object" });
	return "object";
}

/**
 * Repairs an 'object' row whose object is missing (a backup from before a reclaim restored over it) from postal-mime's
 * decoding of its raw, checked against the row's recorded size and digest. It becomes a 'raw' row when the raw verifies
 * it and no other row shares its key; otherwise the object goes back under its key. Returns how the row is stored
 * now, or null when it cannot be repaired (remembered for a minute, so a missing file is not parsed on every read).
 */
export async function repairMissingObject(env: CloudflareEnv, attachmentId: string): Promise<"raw" | "object" | null> {
	if (recentlyUnrepairable(attachmentId)) return null;
	const row = await loadRepairable(env, attachmentId);
	if (!row || isRawAttachmentKey(row.r2Key) || !isRawBackedMessage(row)) return null;
	const source = await sourceFromRaw(env, row);
	if (!source) return markUnrepairable(attachmentId, row.messageId, "no_source");
	const sha256 = await sha256Hex(source.content);
	if (row.sha256 && row.sha256 !== sha256) return markUnrepairable(attachmentId, row.messageId, "digest_mismatch");
	const outcome = await convertToRaw(env, row, source, sha256);
	if (outcome === "converted") {
		log.info("attachment.repaired", { attachmentId, messageId: row.messageId, storage: "raw" });
		return "raw";
	}
	return putBack(env, row, source.content, outcome === "unchanged");
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
	const key = freshAttachmentObjectKey(row.messageId, row.id, newId());
	await putObject(env, key, row, source.content);
	const changed = await changedRows(
		env,
		`UPDATE message_attachments SET storage = 'object', r2_key = ?, raw_offset = NULL, raw_length = NULL,
			transfer_encoding = NULL WHERE id = ? AND storage = 'raw'`,
		[key, row.id],
	);
	// The key is new, so only this row can name it; it goes when the row was repointed or deleted meanwhile, and only
	// while no row names it.
	if (changed !== 1 && (await loadRepairable(env, attachmentId))?.r2Key !== key && !(await isKeyNamed(env, key)))
		await env.BUCKET.delete(key);
	log.info("attachment.repaired", { attachmentId, messageId: row.messageId, storage: "object" });
	return source.content;
}
