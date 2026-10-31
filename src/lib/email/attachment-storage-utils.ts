import { sanitizeFilename } from "./attachment-name-utils";
import { indexMimeParts, matchAttachmentsToParts } from "./mime-index-utils";
import type {
	AttachmentByteRange,
	ObjectDeletionCandidates,
	RawAttachmentLocation,
	RawPartLocation,
	ReferencedObjectKeys,
	RepairableAttachment,
} from "./attachment-storage-types";
import type { AttachmentContent } from "./attachment-types";

/**
 * A 'raw' row's `r2_key`: a sentinel that names no object, so a reader that skips `openAttachment` and passes the key
 * to the bucket gets nothing instead of the whole raw message with its other parts and headers.
 */
const RAW_ATTACHMENT_KEY_PREFIX = "raw:";

export function isRawAttachmentKey(key: string): boolean {
	return key.startsWith(RAW_ATTACHMENT_KEY_PREFIX);
}

/** The sentinel key of a 'raw' row. */
export function rawAttachmentKey(attachmentId: string): string {
	return `${RAW_ATTACHMENT_KEY_PREFIX}${attachmentId}`;
}

/** An on-by-default switch: off only for "0", "false", "off" or "no". */
function isSwitchOn(value: string | undefined): boolean {
	return !["0", "false", "off", "no"].includes((value ?? "").trim().toLowerCase());
}

/**
 * Whether new rows may share another row's object (`ATTACHMENT_SHARING`, on unless "0", "false", "off" or "no"). Off
 * makes sends and forwards write their own copies again, the first step before running a release older than sharing.
 */
export function isAttachmentSharingEnabled(value: string | undefined): boolean {
	return isSwitchOn(value);
}

/**
 * Whether received and imported mail stores its verified attachments as 'raw' rows (`ATTACHMENT_RAW_INDEX`, on unless
 * "0", "false", "off" or "no"). Off makes new mail write a decoded object per attachment again; reads always support
 * both layouts.
 */
export function isAttachmentRawIndexEnabled(value: string | undefined): boolean {
	return isSwitchOn(value);
}

/** Raw messages that are never rewritten: what Kite received and what an import stored. */
const IMMUTABLE_RAW_PREFIXES = ["inbound/", "imports/"];

/**
 * Whether a message's attachments may be 'raw' rows (`docs/specs/attachments-once.md` invariant 1): its raw message
 * is immutable and it is not a draft, whose attachments can be removed. JMAP `drafts/` raws stay 'object'.
 */
export function isRawBackedMessage(message: { rawKey: string | null; status: string }): boolean {
	const { rawKey } = message;
	return !!rawKey && message.status !== "draft" && IMMUTABLE_RAW_PREFIXES.some((prefix) => rawKey.startsWith(prefix));
}

/**
 * For each attachment, the part of `raw` whose decoded bytes are exactly its content, by attachment index. Anything the
 * index cannot verify (quoted-printable, uuencode, a range that decodes to other bytes) has no entry and is stored as
 * an object of its own.
 */
export function locateAttachmentParts(
	raw: ArrayBuffer | Uint8Array,
	attachments: { content: ArrayBuffer | Uint8Array }[],
): Map<number, RawPartLocation> {
	if (!attachments.length) return new Map();
	const { matches } = matchAttachmentsToParts(raw, attachments, indexMimeParts(raw));
	const located = new Map<number, RawPartLocation>();
	for (const { attachmentIndex, part } of matches)
		if (part.transferEncoding)
			located.set(attachmentIndex, {
				offset: part.bodyOffset,
				length: part.bodyLength,
				encoding: part.transferEncoding,
			});
	return located;
}

function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
	if (a.byteLength !== b.byteLength) return false;
	const left = new Uint8Array(a);
	const right = new Uint8Array(b);
	for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
	return true;
}

/**
 * The parsed attachment a stored row came from, for the lazy repair: the same stored name, size and Content-ID. Two
 * candidates with different bytes cannot be told apart, so the row is left alone then instead of risking the wrong file.
 */
export function findAttachmentSource(
	row: Pick<RepairableAttachment, "filename" | "size" | "contentId">,
	attachments: AttachmentContent[],
): AttachmentContent | null {
	const candidates = attachments.filter(
		(attachment) =>
			attachment.content.byteLength === row.size &&
			(attachment.contentId ?? null) === row.contentId &&
			sanitizeFilename(attachment.filename) === row.filename,
	);
	const [first] = candidates;
	return first && candidates.every((other) => sameBytes(other.content, first.content)) ? first : null;
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
	sha256?: string | null;
}): RawAttachmentLocation | null {
	const { rawKey, offset, length, encoding } = row;
	if (!rawKey || offset === null || length === null || !Number.isInteger(offset) || !Number.isInteger(length))
		return null;
	if (offset < 0 || length < 0 || (encoding !== "base64" && encoding !== "identity")) return null;
	return { rawKey, offset, length, encoding, ...(row.sha256 ? { sha256: row.sha256 } : {}) };
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
