import type { MessageAttachment } from "@/app/(dashboard)/inbox/[messageId]/types";
import type { AttachmentPreviewKind } from "./message-attachment-viewer-types";

export function getAttachmentFileUrl(
	messageId: string,
	attachmentId: string,
	mode: "download" | "preview" = "download",
): string {
	const suffix = mode === "preview" ? "?preview=1" : "?download=1";
	return `/api/messages/${messageId}/attachments/${attachmentId}${suffix}`;
}

export function getAttachmentPreviewKind(attachment: Pick<MessageAttachment, "type">): AttachmentPreviewKind {
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
