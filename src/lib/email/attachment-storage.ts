import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messageAttachments, messages } from "@/db/schema";
import { isRawAttachmentKey, resolveByteRange, sliceByteStream, toRawLocation } from "./attachment-storage-utils";
import { createBase64DecodeStream } from "./mime-index-utils";
import type {
	AttachmentByteRange,
	AttachmentRef,
	OpenedAttachment,
	RawAttachmentLocation,
} from "./attachment-storage-types";

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

/** Where a 'raw' row's encoded body is; only asked for rows with a `raw:` key, which exist only after 0088. */
async function rawLocation(env: CloudflareEnv, attachmentId: string): Promise<RawAttachmentLocation | null> {
	const [row] = await getDb(env)
		.select({
			rawKey: messages.rawR2Key,
			offset: messageAttachments.rawOffset,
			length: messageAttachments.rawLength,
			encoding: messageAttachments.transferEncoding,
		})
		.from(messageAttachments)
		.innerJoin(messages, eq(messageAttachments.messageId, messages.id))
		.where(and(eq(messageAttachments.id, attachmentId), eq(messageAttachments.storage, "raw")))
		.limit(1);
	return row ? toRawLocation(row) : null;
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

/** An attachment's decoded bytes as a stream, or a range of them; null when its content is not in storage. */
export async function openAttachment(
	env: CloudflareEnv,
	row: AttachmentRef,
	options: { range?: AttachmentByteRange } = {},
): Promise<OpenedAttachment | null> {
	if (isRawAttachmentKey(row.r2Key)) {
		const location = await rawLocation(env, row.id);
		return location ? openRawAttachment(env.BUCKET, location, row, options.range) : null;
	}
	const object = await getObject(env, row, options.range);
	if (!object) return null;
	const size = object.size ?? row.size;
	const wanted = resolveByteRange(size, options.range);
	return { body: object.body, size: wanted ? wanted.length : size, contentType: row.contentType };
}

/** An attachment's decoded bytes in memory (send, forward, the approval digest); null when not in storage. */
export async function readAttachmentBytes(
	env: CloudflareEnv,
	row: AttachmentRef,
	options: { range?: AttachmentByteRange } = {},
): Promise<ArrayBuffer | null> {
	if (!isRawAttachmentKey(row.r2Key)) {
		const object = await getObject(env, row, options.range);
		return object ? object.arrayBuffer() : null;
	}
	const opened = await openAttachment(env, row, options);
	return opened ? new Response(opened.body).arrayBuffer() : null;
}
