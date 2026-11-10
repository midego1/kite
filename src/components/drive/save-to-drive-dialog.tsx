"use client";

import { useState } from "react";
import toast from "react-hot-toast";
import { AttachmentRiskNotice } from "@/components/attachment-risk-notice";
import { Select } from "@/components/ui/select";
import { useAttachmentRisk } from "@/components/use-attachment-risk";
import { saveAttachment } from "./drive-api";
import { saveAttachmentToMount } from "./drive-mounts-api";
import { attachmentContentUrl } from "./drive-utils";
import { FolderChoiceDialog } from "./folder-choice-dialog";
import { MountFolderPicker } from "./mount-folder-picker";
import { useDriveMounts } from "./use-drive-mounts";

const MY_DRIVE = "";

/**
 * Saves one mail attachment as a Drive file, into My Drive or a folder you pick, or into a linked WebDAV folder
 * when you have one. A flagged file shows its warning and is saved only once the user has ticked it, as the
 * server requires.
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
	const { risk, loading } = useAttachmentRisk(open ? attachmentContentUrl(attachmentId) : null);
	const flagged = !!risk && risk.level !== "ok";
	const [acknowledged, setAcknowledged] = useState(false);
	const { mounts } = useDriveMounts(open);
	const usable = mounts.filter((mount) => mount.status === "ok");
	const [location, setLocation] = useState(MY_DRIVE);
	const [mountPath, setMountPath] = useState("/");
	const mount = usable.find((entry) => entry.id === location) ?? null;
	const mountFolder = mountPath === "/" ? mount?.label : mountPath.slice(mountPath.lastIndexOf("/") + 1);

	return (
		<FolderChoiceDialog
			open={open}
			onOpenChange={(next) => {
				if (!next) {
					setAcknowledged(false);
					setLocation(MY_DRIVE);
					setMountPath("/");
				}
				onOpenChange(next);
			}}
			title="Save to Drive"
			description={
				mount
					? `Choose the folder in ${mount.label} to save a copy of this attachment in.`
					: "Choose the folder to save a copy of this attachment in. It counts against your Drive storage."
			}
			verb="Save"
			location={
				usable.length > 0 && (
					<Select
						aria-label="Save in"
						value={location}
						onChange={(event) => {
							setLocation(event.target.value);
							setMountPath("/");
						}}
					>
						<option value={MY_DRIVE}>My Drive</option>
						{usable.map((entry) => (
							<option key={entry.id} value={entry.id}>
								{entry.label}
							</option>
						))}
					</Select>
				)
			}
			picker={
				mount && (
					<MountFolderPicker
						mountId={mount.id}
						label={mount.label}
						path={mountPath}
						onPathChange={setMountPath}
						active={open}
					/>
				)
			}
			targetName={mount ? mountFolder : undefined}
			notice={<AttachmentRiskNotice risk={risk} acknowledged={acknowledged} onAcknowledgedChange={setAcknowledged} />}
			chooseDisabled={loading || (flagged && !acknowledged)}
			onChoose={async (folder) => {
				if (mount) {
					await saveAttachmentToMount(attachmentId, mount.id, mountPath, flagged && acknowledged);
					toast.success(`Saved to ${mountFolder}`);
					return;
				}
				await saveAttachment(attachmentId, folder?.id ?? null, flagged && acknowledged);
				toast.success(folder ? `Saved to ${folder.name}` : "Saved to My Drive");
			}}
		/>
	);
}
