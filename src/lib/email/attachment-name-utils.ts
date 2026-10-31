import { stripHiddenCharacters } from "./attachment-risk";
import { truncateUtf8 } from "./inbound-limits";

const MAX_FILENAME_BYTES = 180;

/**
 * The display name stored for an attachment: control and bidi characters dropped (so a name cannot reorder or hide its
 * extension), slashes replaced, dot-only names refused, and at most 180 UTF-8 bytes with a short extension kept.
 * The name is never part of the object key (`attachmentObjectKey`).
 */
export function sanitizeFilename(filename: string): string {
	const normalized = stripHiddenCharacters(filename).trim().replace(/[/\\]/g, "_");
	if (!normalized || /^\.+$/.test(normalized)) return "attachment";
	return truncateFilename(normalized, MAX_FILENAME_BYTES) || "attachment";
}

/** `name` cut to at most `maxBytes` UTF-8 bytes, keeping a short extension so the file type survives. */
export function truncateFilename(name: string, maxBytes: number): string {
	if (new TextEncoder().encode(name).byteLength <= maxBytes) return name;
	const extension = /\.[A-Za-z0-9]{1,10}$/.exec(name)?.[0] ?? "";
	return `${truncateUtf8(name.slice(0, name.length - extension.length), maxBytes - extension.length)}${extension}`;
}

/**
 * Object keys carry only ids, so a sender's file name never reaches a storage path (`..` would be collapsed by URL
 * normalisation on an S3 store). Rows keep their own `r2Key`, so objects stored under the older
 * `attachments/<message>/<id>/<name>` keys still read.
 */
export function attachmentObjectKey(messageId: string, attachmentId: string): string {
	return `attachments/${messageId}/${attachmentId}`;
}

/**
 * The key of a copy written for a row that already exists (the storage job's materialize and un-share, the lazy repair
 * of a 'raw' row): `attachmentObjectKey` plus a fresh `suffix`, so no row has ever named it. The row's own key may
 * still be named by a forward or a sent message that shares it, so removing a copy whose row was repointed or deleted
 * meanwhile can never take a file another row uses.
 */
export function freshAttachmentObjectKey(messageId: string, attachmentId: string, suffix: string): string {
	return `${attachmentObjectKey(messageId, attachmentId)}-${suffix}`;
}
