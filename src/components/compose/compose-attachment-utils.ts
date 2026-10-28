import type { MessageAttachment } from "@/app/(dashboard)/inbox/[messageId]/types";
import { getAttachmentFileUrl, getAttachmentPreviewKind } from "@/components/message-attachment-viewer-utils";
import type { ComposeAttachmentEntry, ComposeAttachmentNotice } from "./compose-attachment-types";

/** Cloudflare's limit for a general email message, and the room kept for headers and the body (cloud-attachment-utils.ts). */
const MESSAGE_LIMIT_BYTES = 5 * 1024 * 1024;
const MESSAGE_SAFETY_MARGIN_BYTES = 256 * 1024;
/** From this share of the usable budget on, the composer tells the sender that big files may become links. */
const NEAR_BUDGET_SHARE = 0.6;

/** The file name split at its last dot, so a truncated name can keep its extension visible: "photo.png" → ["photo", ".png"]. */
export function splitFilename(filename: string): { base: string; extension: string } {
	const dot = filename.lastIndexOf(".");
	if (dot <= 0 || dot === filename.length - 1 || filename.length - dot > 12) return { base: filename, extension: "" };
	return { base: filename.slice(0, dot), extension: filename.slice(dot) };
}

/** The attachment shape the reader's viewer and visuals expect, for either kind of composer file. */
export function entryAttachment(entry: ComposeAttachmentEntry, draftId: string | null): MessageAttachment {
	if (entry.kind === "stored") return { ...entry.stored, contentId: null, messageId: draftId ?? "" };
	return {
		contentId: null,
		disposition: "attachment",
		filename: entry.file.name,
		id: entry.id,
		messageId: "",
		size: entry.file.size,
		type: entry.file.type,
	};
}

/**
 * Whether a click on the chip opens the viewer. The page's Content-Security-Policy only lets `blob:` URLs feed
 * images, so a file that is not stored yet previews as an image or as text; everything else downloads.
 */
export function canPreviewEntry(entry: ComposeAttachmentEntry): boolean {
	const kind = getAttachmentPreviewKind({ type: entryAttachmentType(entry) });
	if (entry.kind === "local") return kind === "image" || kind === "text";
	return kind !== "unsupported";
}

/** Only the browser's own `blob:` copy of a file or our authenticated attachment route may feed a link or an image. */
export function safeAttachmentUrl(url: string | null): string {
	return url !== null && (url.startsWith("blob:") || url.startsWith("/api/messages/")) ? url : "";
}

/** The authenticated route a stored file downloads from; a local file has no URL until the viewer makes one. */
export function storedDownloadUrl(entry: ComposeAttachmentEntry, draftId: string | null): string | null {
	if (entry.kind !== "stored" || !draftId) return null;
	return getAttachmentFileUrl(encodeURIComponent(draftId), encodeURIComponent(entry.id), "download");
}

export function storedThumbnailUrl(entry: ComposeAttachmentEntry, draftId: string | null): string | null {
	if (entry.kind !== "stored" || !draftId) return null;
	return getAttachmentFileUrl(encodeURIComponent(draftId), encodeURIComponent(entry.id), "preview");
}

function entryAttachmentType(entry: ComposeAttachmentEntry): string {
	return entry.kind === "stored" ? entry.stored.type : entry.file.type;
}

/** Size of one attachment inside the message: base64 grows it by a third, plus its MIME part headers. */
function encodedSize(size: number): number {
	return Math.ceil(size / 3) * 4 + 2048;
}

/**
 * What the amber notice under the chips should say, or null when nothing needs saying. Cloudflare sends a file over
 * the threshold as a download link for sure; smaller ones only when the sum of the encoded files nears the 5 MiB budget.
 */
export function attachmentNotice(sizes: number[], cloudThresholdBytes: number): ComposeAttachmentNotice | null {
	if (sizes.some((size) => size > cloudThresholdBytes)) return "links";
	const total = sizes.reduce((sum, size) => sum + encodedSize(size), 0);
	return total >= (MESSAGE_LIMIT_BYTES - MESSAGE_SAFETY_MARGIN_BYTES) * NEAR_BUDGET_SHARE ? "near-budget" : null;
}

export function attachmentNoticeText(notice: ComposeAttachmentNotice, cloudThresholdBytes: number): string {
	const limit = `${Math.round(cloudThresholdBytes / 1_000_000)} MB`;
	return notice === "links"
		? `Cloudflare limits general email messages to 5 MiB including encoding, so files over ${limit} are sent as 30-day R2 download links.`
		: "Cloudflare limits general email messages to 5 MiB including encoding. Together these files are close to that, so some may be sent as 30-day R2 download links.";
}
