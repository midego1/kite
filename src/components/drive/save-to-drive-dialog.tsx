"use client";

import toast from "react-hot-toast";
import { saveAttachment } from "./drive-api";
import { FolderChoiceDialog } from "./folder-choice-dialog";

/** Saves one mail attachment as a Drive file, into My Drive or a folder you pick. */
export function SaveToDriveDialog({
	attachmentId,
	open,
	onOpenChange,
}: {
	attachmentId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<FolderChoiceDialog
			open={open}
			onOpenChange={onOpenChange}
			title="Save to Drive"
			description="Choose the folder to save a copy of this attachment in. It counts against your Drive storage."
			verb="Save"
			onChoose={async (folder) => {
				await saveAttachment(attachmentId, folder?.id ?? null);
				toast.success(folder ? `Saved to ${folder.name}` : "Saved to My Drive");
			}}
		/>
	);
}
