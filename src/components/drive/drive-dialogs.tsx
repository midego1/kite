"use client";

import toast from "react-hot-toast";
import { bulkItems, createFolder, renameItem } from "./drive-api";
import { DriveNameDialog } from "./drive-name-dialog";
import { DrivePreviewDialog } from "./drive-preview";
import { DriveShareDialog } from "./drive-share-dialog";
import type { DriveDialog } from "./drive-types";
import { attachmentContentUrl, driveFileUrl, emailHref } from "./drive-utils";
import { FolderChoiceDialog } from "./folder-choice-dialog";
import { SaveToDriveDialog } from "./save-to-drive-dialog";

/** Whichever dialog the listing has open; each closes itself and reloads the listing after a change. */
export function DriveDialogs({
	dialog,
	folderId,
	onClose,
	onChanged,
}: {
	dialog: DriveDialog | null;
	folderId: string | null;
	onClose: () => void;
	onChanged: () => void;
}) {
	if (!dialog) return null;
	const openChange = (open: boolean) => {
		if (!open) onClose();
	};
	switch (dialog.kind) {
		case "new-folder":
			return (
				<DriveNameDialog
					title="New folder"
					initial="Untitled folder"
					submitLabel="Create"
					onClose={onClose}
					onSubmit={async (name) => {
						await createFolder(name, folderId);
						onChanged();
					}}
				/>
			);
		case "rename":
			return (
				<DriveNameDialog
					title="Rename"
					initial={dialog.item.name}
					submitLabel="Save"
					onClose={onClose}
					onSubmit={async (name) => {
						await renameItem(dialog.item.id, name);
						onChanged();
					}}
				/>
			);
		case "move":
			return (
				<FolderChoiceDialog
					open
					onOpenChange={openChange}
					title={dialog.items.length === 1 ? `Move “${dialog.items[0].name}”` : `Move ${dialog.items.length} items`}
					description="Choose the folder to move to."
					verb="Move"
					exclude={new Set(dialog.items.map((item) => item.id))}
					onChoose={async (folder) => {
						const { count } = await bulkItems(
							dialog.items.map((item) => item.id),
							"move",
							folder?.id ?? null,
						);
						toast.success(`Moved ${count} to ${folder ? folder.name : "My Drive"}`);
						onChanged();
					}}
				/>
			);
		case "save":
			return <SaveToDriveDialog attachmentId={dialog.item.id} open onOpenChange={openChange} />;
		case "share":
			return <DriveShareDialog item={dialog.item} onClose={onClose} onChanged={onChanged} />;
		case "preview":
			return (
				<DrivePreviewDialog
					onClose={onClose}
					target={{
						name: dialog.item.name,
						size: dialog.item.size,
						contentType: dialog.item.contentType,
						src: driveFileUrl(dialog.item),
						downloadHref: driveFileUrl(dialog.item, true),
						emailHref: dialog.item.source ? emailHref(dialog.item.source) : undefined,
						riskUrl: dialog.item.source ? attachmentContentUrl(dialog.item.id) : undefined,
					}}
				/>
			);
	}
}
