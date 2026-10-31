import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { messageAttachments, messages } from "@/db/schema";
import { chunkArray, queryInChunks } from "@/db/chunk-utils";
import { missingColumnFromError } from "@/lib/auth/user-lookup-utils";
import { createLogger } from "@/lib/logger.mjs";
import { sha256Hex } from "@/lib/aws/sigv4";
import { materializeMismatchedRaw, repairLostRawLocation, repairMissingObject } from "./attachment-repair";
import {
	ATTACHMENT_OBJECT_ROWS_SQL,
	isRawAttachmentKey,
	planObjectDeletion,
	rawAttachmentKey,
	referenceCheckedKeys,
	resolveByteRange,
	sliceByteStream,
	toRawLocation,
} from "./attachment-storage-utils";
import { createBase64DecodeStream } from "./mime-index-utils";
import type {
	AttachmentByteRange,
	AttachmentRef,
	ObjectDeletionCandidates,
	OpenedAttachment,
	RawAttachmentLocation,
	RawPartLocation,
	ReferencedObjectKeys,
	SharedAttachmentRow,
} from "./attachment-storage-types";

const log = createLogger("attachments");

/** R2 accepts up to 1,000 keys in one delete call. */
const R2_DELETE_BATCH = 1000;

/**
 * The only module that turns an attachment row into bytes (`docs/specs/attachments-once.md`;
 * `tests/attachment-storage-boundary.test.mjs` keeps every other reader from passing a row's `r2Key` to a bucket).
 * A row with `storage` 'object' is its own object under `r2Key`. A 'raw' row (sentinel key `raw:<id>`) is the decoded
 * byte range of its message's raw MIME; that range is the only part of the raw ever read for it, so a share link or a
 * JMAP blob can never return the message's other parts or headers.
 */

/**
 * The columns of a whole attachment row. The storage columns of migration 0088 are left out so these reads keep
 * working on a database whose schema is behind; a 'raw' row is recognised by its key and located separately.
 */
export const ATTACHMENT_ROW_COLUMNS = {
	id: messageAttachments.id,
	messageId: messageAttachments.messageId,
	filename: messageAttachments.filename,
	contentType: messageAttachments.contentType,
	size: messageAttachments.size,
	disposition: messageAttachments.disposition,
	contentId: messageAttachments.contentId,
	r2Key: messageAttachments.r2Key,
	createdAt: messageAttachments.createdAt,
};

/** A row with a `raw:` key whose storage columns say 'object': where its bytes are was lost (`repairLostRawLocation`). */
const LOST_LOCATION = "lost";

/**
 * Where a 'raw' row's encoded body is; only asked for rows with a `raw:` key. Such a row can sit in a database without
 * migration 0088 when an older release restored a newer backup into it; the storage columns are missing then, so it
 * reads as not stored (404) instead of failing the request, and as `LOST_LOCATION` once 0088 is applied.
 */
async function rawLocation(
	env: CloudflareEnv,
	attachmentId: string,
): Promise<RawAttachmentLocation | typeof LOST_LOCATION | null> {
	try {
		return await findRawLocation(env, attachmentId);
	} catch (error) {
		if (missingColumnFromError(error)) return null;
		throw error;
	}
}

async function findRawLocation(
	env: CloudflareEnv,
	attachmentId: string,
): Promise<RawAttachmentLocation | typeof LOST_LOCATION | null> {
	const [row] = await getDb(env)
		.select({
			storage: messageAttachments.storage,
			rawKey: messages.rawR2Key,
			offset: messageAttachments.rawOffset,
			length: messageAttachments.rawLength,
			encoding: messageAttachments.transferEncoding,
			sha256: messageAttachments.sha256,
		})
		.from(messageAttachments)
		.innerJoin(messages, eq(messageAttachments.messageId, messages.id))
		.where(eq(messageAttachments.id, attachmentId))
		.limit(1);
	if (!row) return null;
	return row.storage === "raw" ? toRawLocation(row) : LOST_LOCATION;
}

/** Bytes already in memory as an opened attachment, cut to `range`. */
function openedBytes(
	bytes: ArrayBuffer,
	row: Pick<AttachmentRef, "contentType">,
	range: AttachmentByteRange | undefined,
): OpenedAttachment {
	const wanted = resolveByteRange(bytes.byteLength, range);
	const slice = wanted ? bytes.slice(wanted.offset, wanted.offset + wanted.length) : bytes;
	return { body: new Response(slice).body!, size: slice.byteLength, contentType: row.contentType };
}

function emptyStream(): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
}

/**
 * Opens a 'raw' row from its location: one ranged read of exactly the encoded body, decoded as it streams. A range of
 * the decoded bytes reads the matching raw bytes directly for `identity`, and is cut from the decoded stream for
 * base64, whose encoded offsets do not map onto decoded ones.
 * @public Exercised by the unit tests; `openAttachment` is the way in.
 */
export async function openRawAttachment(
	bucket: Pick<R2Bucket, "get">,
	location: RawAttachmentLocation,
	row: Pick<AttachmentRef, "size" | "contentType">,
	range?: AttachmentByteRange,
): Promise<OpenedAttachment | null> {
	const wanted = resolveByteRange(row.size, range);
	const size = wanted ? wanted.length : row.size;
	if (location.encoding === "identity") {
		const offset = location.offset + (wanted?.offset ?? 0);
		const length = Math.min(size, location.length - (wanted?.offset ?? 0));
		if (length <= 0) return { body: emptyStream(), size: 0, contentType: row.contentType };
		const object = await bucket.get(location.rawKey, { range: { offset, length } });
		return object ? { body: object.body, size: length, contentType: row.contentType } : null;
	}
	const object = await bucket.get(location.rawKey, { range: { offset: location.offset, length: location.length } });
	if (!object) return null;
	const decoded = object.body.pipeThrough(createBase64DecodeStream());
	const body = wanted ? decoded.pipeThrough(sliceByteStream(wanted.offset, wanted.length)) : decoded;
	return { body, size, contentType: row.contentType };
}

/** The object an 'object' row names, ranged when asked; the bucket clamps the range. */
function getObject(env: CloudflareEnv, row: AttachmentRef, range: AttachmentByteRange | undefined) {
	return env.BUCKET.get(row.r2Key, range ? { range } : undefined);
}

async function openRawRow(env: CloudflareEnv, row: AttachmentRef, range: AttachmentByteRange | undefined) {
	const location = await rawLocation(env, row.id);
	if (location === LOST_LOCATION) {
		const bytes = await repairLostRawLocation(env, row.id);
		return bytes ? openedBytes(bytes, row, range) : null;
	}
	return location ? openRawAttachment(env.BUCKET, location, row, range) : null;
}

/**
 * The object of an 'object' row; when it is missing, the lazy repair rebuilds the row from its message's raw (a
 * 'raw' row then, or its object put back) and it is read again. Null when it cannot be repaired.
 */
async function openObjectRow(
	env: CloudflareEnv,
	row: AttachmentRef,
	range: AttachmentByteRange | undefined,
): Promise<{ object: R2ObjectBody } | { repaired: OpenedAttachment } | null> {
	const object = await getObject(env, row, range);
	if (object) return { object };
	const repaired = await repairMissingObject(env, row.id);
	if (repaired === "raw") {
		const opened = await openRawRow(env, { ...row, r2Key: rawAttachmentKey(row.id) }, range);
		return opened ? { repaired: opened } : null;
	}
	const restored = repaired === "object" ? await getObject(env, row, range) : null;
	return restored ? { object: restored } : null;
}

/** An attachment's decoded bytes as a stream, or a range of them; null when its content is not in storage. */
export async function openAttachment(
	env: CloudflareEnv,
	row: AttachmentRef,
	options: { range?: AttachmentByteRange } = {},
): Promise<OpenedAttachment | null> {
	if (isRawAttachmentKey(row.r2Key)) return openRawRow(env, row, options.range);
	const read = await openObjectRow(env, row, options.range);
	if (!read || "repaired" in read) return read?.repaired ?? null;
	const size = read.object.size ?? row.size;
	const wanted = resolveByteRange(size, options.range);
	return { body: read.object.body, size: wanted ? wanted.length : size, contentType: row.contentType };
}

/**
 * A whole 'raw' row in memory, checked against the size and digest recorded when it was verified at ingest. A range
 * that no longer decodes to them is never returned: the lazy repair materializes the bytes postal-mime decodes from the
 * raw when those match, and otherwise the row reads as not stored.
 */
async function readRawRow(env: CloudflareEnv, row: AttachmentRef): Promise<ArrayBuffer | null> {
	const location = await rawLocation(env, row.id);
	if (location === LOST_LOCATION) return repairLostRawLocation(env, row.id);
	const opened = location ? await openRawAttachment(env.BUCKET, location, row) : null;
	if (!location || !opened) return null;
	const bytes = await new Response(opened.body).arrayBuffer();
	const expected = { size: row.size, sha256: location.sha256 ?? null };
	if (bytes.byteLength === expected.size && (!expected.sha256 || (await sha256Hex(bytes)) === expected.sha256))
		return bytes;
	return materializeMismatchedRaw(env, row.id, expected);
}

/** An attachment's decoded bytes in memory (send, forward, the approval digest); null when not in storage. */
export async function readAttachmentBytes(
	env: CloudflareEnv,
	row: AttachmentRef,
	options: { range?: AttachmentByteRange } = {},
): Promise<ArrayBuffer | null> {
	if (isRawAttachmentKey(row.r2Key)) {
		if (!options.range) return readRawRow(env, row);
		const opened = await openRawRow(env, row, options.range);
		return opened ? new Response(opened.body).arrayBuffer() : null;
	}
	const read = await openObjectRow(env, row, options.range);
	if (!read) return null;
	return "repaired" in read ? new Response(read.repaired.body).arrayBuffer() : read.object.arrayBuffer();
}

/**
 * The row a share inserts: everything but the key and the size, which come from the source row in the same statement.
 * `created_at` is in seconds, as Drizzle's `timestamp` mode stores it.
 */
function sharedRowParams(row: SharedAttachmentRow): unknown[] {
	return [
		row.id,
		row.messageId,
		row.filename,
		row.contentType,
		row.disposition,
		row.contentId,
		Math.floor(Date.now() / 1000),
	];
}

const SHARED_COLUMNS = "id, message_id, filename, content_type, disposition, content_id, created_at, size, r2_key";

/**
 * Before migration 0088 `r2_key` is unique, so a share fails; the caller writes its own object then, as before.
 * Any other error is real.
 */
function isUniqueKeyError(error: unknown): boolean {
	return /UNIQUE constraint failed: message_attachments\.r2_key/i.test(String((error as Error)?.message ?? error));
}

async function insertShared(env: CloudflareEnv, statement: string, params: unknown[]) {
	try {
		const row = await env.DB.prepare(statement)
			.bind(...params)
			.first<{ r2Key: string; size: number }>();
		return row ?? null;
	} catch (error) {
		if (isUniqueKeyError(error)) return null;
		throw error;
	}
}

/** `VALUES` placeholders for `count` parameters. */
const placeholders = (count: number) => Array.from({ length: count }, () => "?").join(", ");

/**
 * Inserts the row of an object written for it. It names only columns every schema has (plus `sha256` when known, retried
 * without it before migration 0088), so a deploy running ahead of the migration costs one statement per attachment.
 */
export async function insertObjectAttachmentRow(
	env: CloudflareEnv,
	row: SharedAttachmentRow,
	object: { r2Key: string; size: number; sha256?: string },
): Promise<void> {
	const params = [...sharedRowParams(row), object.size, object.r2Key];
	if (object.sha256) {
		try {
			await env.DB.prepare(
				`INSERT INTO message_attachments (${SHARED_COLUMNS}, sha256) VALUES (${placeholders(params.length + 1)})`,
			)
				.bind(...params, object.sha256)
				.run();
			return;
		} catch (error) {
			if (!missingColumnFromError(error)) throw error;
		}
	}
	await env.DB.prepare(`INSERT INTO message_attachments (${SHARED_COLUMNS}) VALUES (${placeholders(params.length)})`)
		.bind(...params)
		.run();
}

/**
 * Inserts a 'raw' row: no object, the sentinel key, and where its verified encoded body sits in the message's raw
 * (`docs/specs/attachments-once.md` invariants 2 and 3). False before migration 0088, when the storage columns do not
 * exist; the caller writes an object then, as before.
 */
export async function insertRawAttachmentRow(
	env: CloudflareEnv,
	row: SharedAttachmentRow,
	stored: { size: number; sha256: string; part: RawPartLocation },
): Promise<boolean> {
	const { part } = stored;
	const params = [
		...sharedRowParams(row),
		stored.size,
		rawAttachmentKey(row.id),
		"raw",
		part.offset,
		part.length,
		part.encoding,
		stored.sha256,
	];
	try {
		await env.DB.prepare(
			`INSERT INTO message_attachments (${SHARED_COLUMNS}, storage, raw_offset, raw_length, transfer_encoding, sha256) VALUES (${placeholders(params.length)})`,
		)
			.bind(...params)
			.run();
		return true;
	} catch (error) {
		if (missingColumnFromError(error)) return false;
		throw error;
	}
}

/**
 * Inserts `row` naming the object of the 'object' row `sourceId`, in one statement (`docs/specs/attachments-once.md`
 * invariant 5): a key no row names any more can never gain a reference again, so a delete that found it unreferenced
 * never races a share. Null when the source is gone, is a 'raw' row, or keys cannot be shared yet (before 0088); the
 * caller then writes the bytes itself.
 */
export function shareAttachmentObject(
	env: CloudflareEnv,
	row: SharedAttachmentRow,
	sourceId: string,
): Promise<{ r2Key: string; size: number } | null> {
	return insertShared(
		env,
		`INSERT INTO message_attachments (${SHARED_COLUMNS})
			SELECT ?, ?, ?, ?, ?, ?, ?, size, r2_key FROM message_attachments WHERE id = ? AND ${ATTACHMENT_OBJECT_ROWS_SQL}
			RETURNING r2_key AS r2Key, size`,
		[...sharedRowParams(row), sourceId],
	);
}

/**
 * Inserts `row` naming an existing object with the same decoded bytes (`sha256`, `size`) that belongs to a message of
 * the same user as `row.messageId`, so content is never linked between accounts (spec §6). Used for a forwarded 'raw'
 * row, which has no object to share; null when there is none.
 */
export function shareAttachmentObjectByDigest(
	env: CloudflareEnv,
	row: SharedAttachmentRow,
	digest: { sha256: string; size: number },
): Promise<{ r2Key: string; size: number } | null> {
	return insertShared(
		env,
		`INSERT INTO message_attachments (${SHARED_COLUMNS}, sha256)
			SELECT ?, ?, ?, ?, ?, ?, ?, a.size, a.r2_key, a.sha256
			FROM message_attachments a JOIN messages m ON m.id = a.message_id AND ${ATTACHMENT_OBJECT_ROWS_SQL}
			WHERE a.sha256 = ? AND a.size = ? AND a.storage = 'object'
				AND m.user_id = (SELECT user_id FROM messages WHERE id = ?)
			LIMIT 1
			RETURNING r2_key AS r2Key, size`,
		[...sharedRowParams(row), digest.sha256, digest.size, row.messageId],
	);
}

/** The candidate keys that rows still name; read after the deleted rows are gone. */
async function findReferencedKeys(
	env: CloudflareEnv,
	candidates: ObjectDeletionCandidates,
): Promise<ReferencedObjectKeys> {
	const db = getDb(env);
	const { attachmentKeys, rawKeys } = referenceCheckedKeys(candidates);
	const [attachments, raws] = await Promise.all([
		queryInChunks(attachmentKeys, (chunk) =>
			db
				.selectDistinct({ key: messageAttachments.r2Key })
				.from(messageAttachments)
				.where(inArray(messageAttachments.r2Key, chunk)),
		),
		queryInChunks(rawKeys, (chunk) =>
			db.selectDistinct({ key: messages.rawR2Key }).from(messages).where(inArray(messages.rawR2Key, chunk)),
		),
	]);
	return {
		attachmentKeys: attachments.map((row) => row.key),
		rawKeys: raws.flatMap((row) => (row.key ? [row.key] : [])),
	};
}

/**
 * Deletes the objects of rows that are already gone, keeping every object a remaining row still names
 * (`docs/specs/attachments-once.md` §5.4). Callers delete their rows first: if storage fails afterwards the cost is an
 * orphaned object, never a missing file that another message still uses. It never throws, since the rows are gone
 * and the request has done its work; keys it could not delete are logged (ids only) until an orphan sweep exists.
 */
export async function deleteUnreferencedObjects(
	env: CloudflareEnv,
	candidates: ObjectDeletionCandidates,
): Promise<void> {
	let keys: string[];
	try {
		keys = planObjectDeletion(candidates, await findReferencedKeys(env, candidates));
	} catch (error) {
		const { attachmentKeys, rawKeys } = referenceCheckedKeys(candidates);
		log.error("attachment.objects_orphaned", { keys: [...attachmentKeys, ...rawKeys], error });
		keys = planObjectDeletion({ ownedKeys: candidates.ownedKeys }, { attachmentKeys: [], rawKeys: [] });
	}
	for (const batch of chunkArray(keys, R2_DELETE_BATCH)) {
		try {
			await env.BUCKET.delete(batch);
		} catch (error) {
			log.error("attachment.objects_orphaned", { keys: batch, error });
		}
	}
}
