import type { AttachmentByteRange, RawAttachmentLocation } from "./attachment-storage-types";

/**
 * A 'raw' row's `r2_key`: a sentinel that names no object, so a reader that skips `openAttachment` and passes the key
 * to the bucket gets nothing instead of the whole raw message with its other parts and headers.
 */
const RAW_ATTACHMENT_KEY_PREFIX = "raw:";

export function isRawAttachmentKey(key: string): boolean {
	return key.startsWith(RAW_ATTACHMENT_KEY_PREFIX);
}

/**
 * The sentinel key of a 'raw' row.
 * @public Written by raw-backed ingest (a later step of docs/specs/attachments-once.md); exercised by the unit tests.
 */
export function rawAttachmentKey(attachmentId: string): string {
	return `${RAW_ATTACHMENT_KEY_PREFIX}${attachmentId}`;
}

/** A requested range as `{ offset, length }` within `size` bytes, clamped like R2 clamps it; null for all of it. */
export function resolveByteRange(
	size: number,
	range: AttachmentByteRange | undefined,
): { offset: number; length: number } | null {
	if (!range) return null;
	if ("suffix" in range) {
		const length = Math.min(Math.max(0, range.suffix), size);
		return { offset: size - length, length };
	}
	const offset = Math.min(Math.max(0, range.offset), size);
	const length = Math.min(Math.max(0, range.length ?? size - offset), size - offset);
	return { offset, length };
}

/** A database row's raw location, or null when anything about it is unusable. */
export function toRawLocation(row: {
	rawKey: string | null;
	offset: number | null;
	length: number | null;
	encoding: string | null;
}): RawAttachmentLocation | null {
	const { rawKey, offset, length, encoding } = row;
	if (!rawKey || offset === null || length === null || !Number.isInteger(offset) || !Number.isInteger(length))
		return null;
	if (offset < 0 || length < 0 || (encoding !== "base64" && encoding !== "identity")) return null;
	return { rawKey, offset, length, encoding };
}

/** Passes on bytes `[offset, offset + length)` of a stream and drops the rest. */
export function sliceByteStream(offset: number, length: number): TransformStream<Uint8Array, Uint8Array> {
	let position = 0;
	const end = offset + length;
	return new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			const start = position;
			position += chunk.length;
			if (position <= offset || start >= end) return;
			controller.enqueue(chunk.subarray(Math.max(0, offset - start), Math.min(chunk.length, end - start)));
		},
	});
}

/**
 * SQL over `message_attachments` for rows that own an object of their own: backups and storage migrations copy only
 * these, since a 'raw' row's bytes travel with the raw message. Written against `r2_key`, which every schema has.
 */
export const ATTACHMENT_OBJECT_ROWS_SQL = "substr(r2_key, 1, 4) <> 'raw:'";

/** The object keys among attachment rows' `r2Key`s; a 'raw' row's sentinel is never passed to the bucket. */
export function attachmentObjectKeys(rows: { r2Key: string }[]): string[] {
	return rows.map((row) => row.r2Key).filter((key) => !isRawAttachmentKey(key));
}
