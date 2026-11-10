"use client";

import { useState } from "react";
import toast from "react-hot-toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { DriveMountDto, DriveMountItemDto } from "@/lib/drive/types";
import { createMountFolder, mountFileUrl, moveMountItem } from "./drive-mounts-api";
import { DriveMountDialog } from "./drive-mount-dialog";
import { DriveNameDialog } from "./drive-name-dialog";
import { DrivePreviewDialog } from "./drive-preview";
import { MountFolderPicker } from "./mount-folder-picker";

export type MountDialog =
	| { kind: "new-folder" }
	| { kind: "rename"; item: DriveMountItemDto }
	| { kind: "move"; item: DriveMountItemDto }
	| { kind: "preview"; item: DriveMountItemDto }
	| { kind: "edit" };

const parentOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), 0)) || "/";

function MoveDialog({
	mount,
	item,
	onClose,
	onChanged,
}: {
	mount: DriveMountDto;
	item: DriveMountItemDto;
	onClose: () => void;
	onChanged: () => void;
}) {
	const [path, setPath] = useState(parentOf(item.path));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const folderName = path === "/" ? mount.label : path.slice(path.lastIndexOf("/") + 1);
	async function move() {
		setBusy(true);
		setError(null);
		try {
			await moveMountItem(mount.id, item.path, { parent: path });
			toast.success(`Moved to ${folderName}`);
			onChanged();
			onClose();
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Something went wrong");
			setBusy(false);
		}
	}
	return (
		<Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
			<DialogContent className="max-h-[calc(100vh-4rem)] overflow-y-auto sm:max-w-md" data-drive-folder-dialog>
				<DialogHeader>
					<DialogTitle>Move “{item.name}”</DialogTitle>
					<DialogDescription>Choose the folder to move to, inside {mount.label}.</DialogDescription>
				</DialogHeader>
				<MountFolderPicker
					mountId={mount.id}
					label={mount.label}
					path={path}
					onPathChange={setPath}
					active
					exclude={item.path}
				/>
				{error && (
					<p role="alert" className="text-sm text-red-600">
						{error}
					</p>
				)}
				<div className="flex justify-end gap-2">
					<Button type="button" variant="outline" onClick={onClose} disabled={busy}>
						Cancel
					</Button>
					<Button
						type="button"
						onClick={() => void move()}
						disabled={busy || path === parentOf(item.path) || path.startsWith(`${item.path}/`)}
					>
						{busy ? "Working…" : `Move to ${folderName}`}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}

/** Whichever dialog the linked folder's listing has open. */
export function DriveMountDialogs({
	dialog,
	mount,
	path,
	onClose,
	onChanged,
}: {
	dialog: MountDialog | null;
	mount: DriveMountDto | null;
	path: string;
	onClose: () => void;
	onChanged: () => void;
}) {
	if (!dialog || !mount) return null;
	switch (dialog.kind) {
		case "new-folder":
			return (
				<DriveNameDialog
					title="New folder"
					initial="Untitled folder"
					submitLabel="Create"
					onClose={onClose}
					onSubmit={async (name) => {
						await createMountFolder(mount.id, path, name);
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
						if (name !== dialog.item.name) await moveMountItem(mount.id, dialog.item.path, { name });
						onChanged();
					}}
				/>
			);
		case "move":
			return <MoveDialog mount={mount} item={dialog.item} onClose={onClose} onChanged={onChanged} />;
		case "preview":
			return (
				<DrivePreviewDialog
					onClose={onClose}
					target={{
						name: dialog.item.name,
						size: dialog.item.size,
						contentType: dialog.item.contentType ?? "application/octet-stream",
						src: mountFileUrl(mount.id, dialog.item.path),
						downloadHref: mountFileUrl(mount.id, dialog.item.path, true),
					}}
				/>
			);
		case "edit":
			return <DriveMountDialog mount={mount} onClose={onClose} onSaved={onChanged} />;
	}
}
