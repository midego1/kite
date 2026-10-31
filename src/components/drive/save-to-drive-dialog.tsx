"use client";

import { useState } from "react";
import toast from "react-hot-toast";
import { AttachmentRiskNotice } from "@/components/attachment-risk-notice";
import { useAttachmentRisk } from "@/components/use-attachment-risk";
import { saveAttachment } from "./drive-api";
import { attachmentContentUrl } from "./drive-utils";
import { FolderChoiceDialog } from "./folder-choice-dialog";

/**
 * Saves one mail attachment as a Drive file, into My Drive or a folder you pick. A flagged file shows its warning
 * and is saved only once the user has ticked it, as the server requires.
 */
export function SaveToDriveDialog({
	attachmentId,
	open,
	onOpenChange,
}: {
	attachmentId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const risk = useAttachmentRisk(open ? attachmentContentUrl(attachmentId) : null);
	const flagged = !!risk && risk.level !== "ok";
	const [acknowledged, setAcknowledged] = useState(false);
	return (
		<FolderChoiceDialog
			open={open}
			onOpenChange={(next) => {
				if (!next) setAcknowledged(false);
				onOpenChange(next);
			}}
			title="Save to Drive"
			description="Choose the folder to save a copy of this attachment in. It counts against your Drive storage."
			verb="Save"
			notice={<AttachmentRiskNotice risk={risk} acknowledged={acknowledged} onAcknowledgedChange={setAcknowledged} />}
			chooseDisabled={flagged && !acknowledged}
			onChoose={async (folder) => {
				await saveAttachment(attachmentId, folder?.id ?? null, flagged && acknowledged);
				toast.success(folder ? `Saved to ${folder.name}` : "Saved to My Drive");
			}}
		/>
	);
}
