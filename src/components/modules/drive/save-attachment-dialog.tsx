"use client";

import { SaveToDriveDialog } from "@/components/drive/save-to-drive-dialog";
import type { AttachmentSlotContext } from "../client-registry-types";

type OverlayProps = AttachmentSlotContext & { open: boolean; onOpenChange: (open: boolean) => void };

export function SaveAttachmentDialog({ attachmentId, open, onOpenChange }: OverlayProps) {
	return <SaveToDriveDialog attachmentId={attachmentId} open={open} onOpenChange={onOpenChange} />;
}
