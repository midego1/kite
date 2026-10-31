import { assessAttachmentRisk } from "@/lib/email/attachment-risk";
import type { MessageAttachment } from "@/app/(dashboard)/inbox/[messageId]/types";
import type { AttachmentPreviewKind } from "./message-attachment-viewer-types";

/** The attachment route: `file` is the bare route (as the sender marked it), the others force preview or download. */
export function getAttachmentFileUrl(
	messageId: string,
	attachmentId: string,
	mode: "download" | "file" | "preview" = "download",
): string {
	const suffix = mode === "preview" ? "?preview=1" : mode === "download" ? "?download=1" : "";
	return `/api/messages/${messageId}/attachments/${attachmentId}${suffix}`;
}

/**
 * How the viewer shows a file, from its declared type. A name the risk check flags (`setup.exe` declared `image/png`)
 * is never previewed: the server refuses to render it inline, so it only downloads, after its warning.
 */
export function getAttachmentPreviewKind(
	attachment: Pick<MessageAttachment, "type"> & { filename?: string },
): AttachmentPreviewKind {
	const { filename } = attachment;
	if (filename !== undefined && assessAttachmentRisk({ filename, type: attachment.type }).level !== "ok")
		return "unsupported";
	if (attachment.type === "application/pdf") return "pdf";
	if (attachment.type.startsWith("audio/")) return "audio";
	if (attachment.type.startsWith("video/")) return "video";
	if (attachment.type.startsWith("image/") && attachment.type !== "image/svg+xml") return "image";
	if (
		attachment.type.startsWith("text/plain") ||
		attachment.type === "application/json" ||
		attachment.type === "application/xml" ||
		attachment.type === "text/csv"
	) {
		return "text";
	}
	return "unsupported";
}

/**
 * Where the viewer loads an attachment from: the authenticated route for a stored one, or the `blob:` URL of the
 * browser's copy of a file that is not stored yet ("" until that copy is ready).
 */
export function getViewerUrls(
	attachment: Pick<MessageAttachment, "id"> | null,
	messageId: string,
	localUrl: string | null,
): { previewUrl: string; downloadUrl: string } {
	if (localUrl !== null) return { previewUrl: localUrl, downloadUrl: localUrl };
	if (!attachment) return { previewUrl: "", downloadUrl: "" };
	return {
		previewUrl: getAttachmentFileUrl(messageId, attachment.id, "preview"),
		downloadUrl: getAttachmentFileUrl(messageId, attachment.id, "download"),
	};
}
