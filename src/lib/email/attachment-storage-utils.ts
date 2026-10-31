import type {
	AttachmentByteRange,
	ObjectDeletionCandidates,
	RawAttachmentLocation,
	ReferencedObjectKeys,
} from "./attachment-storage-types";

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

/**
 * Whether new rows may share another row's object (`ATTACHMENT_SHARING`, on unless "0", "false", "off" or "no"). Off
 * makes sends and forwards write their own copies again, the first step before running a release older than sharing.
 */
export function isAttachmentSharingEnabled(value: string | undefined): boolean {
	return !["0", "false", "off", "no"].includes((value ?? "").trim().toLowerCase());
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

/**
 * Passes on bytes `[offset, offset + length)` of a stream and drops the rest. Once the range is complete it terminates,
 * which cancels the source of a `pipeThrough`, so a range near the start never reads (or decodes) the rest.
 */
export function sliceByteStream(offset: number, length: number): TransformStream<Uint8Array, Uint8Array> {
	let position = 0;
	const end = offset + length;
	return new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			const start = position;
			position += chunk.length;
			if (position > offset && start < end)
				controller.enqueue(chunk.subarray(Math.max(0, offset - start), Math.min(chunk.length, end - start)));
			if (position >= end) controller.terminate();
		},
	});
}

/**
 * SQL over `message_attachments` for rows that own an object of their own: backups and storage migrations copy only
 * these, since a 'raw' row's bytes travel with the raw message. Written against `r2_key`, which every schema has.
 */
export const ATTACHMENT_OBJECT_ROWS_SQL = "substr(r2_key, 1, 4) <> 'raw:'";

/** The object keys among attachment rows' `r2Key`s, once each; a 'raw' row's sentinel is never passed to the bucket. */
export function attachmentObjectKeys(rows: { r2Key: string }[]): string[] {
	return [...new Set(rows.map((row) => row.r2Key).filter((key) => !isRawAttachmentKey(key)))];
}

/** Present keys, once each. */
function presentKeys(keys: readonly (string | null | undefined)[] | undefined): string[] {
	return [...new Set((keys ?? []).filter((key): key is string => !!key))];
}

/** The attachment and raw keys whose references have to be looked up before they may go. */
export function referenceCheckedKeys(candidates: ObjectDeletionCandidates): ReferencedObjectKeys {
	return {
		attachmentKeys: presentKeys(candidates.attachmentKeys).filter((key) => !isRawAttachmentKey(key)),
		rawKeys: presentKeys(candidates.rawKeys),
	};
}

/**
 * The keys a delete may remove once its rows are gone (`docs/specs/attachments-once.md` §5.4): attachment objects no
 * remaining row names (a forward or a send shares the object instead of copying it), raw messages no remaining message
 * names, and the keys only the deleted messages owned. `raw:` sentinels name no object and are never returned.
 */
export function planObjectDeletion(candidates: ObjectDeletionCandidates, referenced: ReferencedObjectKeys): string[] {
	const checked = referenceCheckedKeys(candidates);
	const kept = new Set([...referenced.attachmentKeys, ...referenced.rawKeys]);
	return presentKeys([
		...checked.attachmentKeys.filter((key) => !kept.has(key)),
		...checked.rawKeys.filter((key) => !kept.has(key)),
		...presentKeys(candidates.ownedKeys).filter((key) => !isRawAttachmentKey(key)),
	]);
}
