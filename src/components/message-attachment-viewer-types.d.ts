import type { MessageAttachment } from "@/app/(dashboard)/inbox/[messageId]/types";

export interface MessageAttachmentViewerProps {
	attachment: MessageAttachment | null;
	messageId: string;
	/** A file that is not stored yet, e.g. in the composer: shown from the browser's own copy instead of the attachment route. */
	file?: File | null;
	onOpenChange: (open: boolean) => void;
	open: boolean;
}

export type AttachmentPreviewKind = "audio" | "image" | "pdf" | "text" | "unsupported" | "video";
