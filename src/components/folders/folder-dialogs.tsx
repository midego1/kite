"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { FolderMoveTarget, FolderUsage } from "@/lib/folders/manage-types";
import { FOLDER_MOVE_LABELS, FOLDER_MOVE_TARGETS, folderDeleteSummary } from "@/lib/folders/manage-utils";
import type { CustomFolder } from "@/components/dashboard-nav-types";
import { deleteFolderRequest, fetchFolderUsage, renameFolder } from "./folder-requests";

type DialogProps = {
	folder: CustomFolder;
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

/** Phone sidebar sheet sits at z-[100]; the dialog has to open above it. */
const ABOVE_SHEET = "z-[110]";

/** Mounted only while open, so every opening starts from fresh state. */
export function RenameFolderDialog(props: DialogProps) {
	return props.open ? <RenameFolderBody {...props} /> : null;
}

export function DeleteFolderDialog(props: DialogProps & { onDeleted: () => void }) {
	return props.open ? <DeleteFolderBody {...props} /> : null;
}

function RenameFolderBody({ folder, open, onOpenChange }: DialogProps) {
	const [name, setName] = useState(folder.name);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const next = name.trim();
		if (!next || saving) return;
		if (next === folder.name) {
			onOpenChange(false);
			return;
		}
		setSaving(true);
		setError(null);
		const result = await renameFolder(folder.id, next);
		setSaving(false);
		if (result.ok) onOpenChange(false);
		else setError(result.status === 409 ? "A folder with that name already exists." : result.error);
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent overlayClassName={ABOVE_SHEET} className={ABOVE_SHEET}>
				<DialogHeader>
					<DialogTitle>Rename folder</DialogTitle>
					<DialogDescription>Messages stay in the folder; only its name changes.</DialogDescription>
				</DialogHeader>
				<form onSubmit={submit} className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="renameFolderName">Folder name</Label>
						<Input
							id="renameFolderName"
							value={name}
							maxLength={80}
							autoFocus
							onFocus={(event) => event.currentTarget.select()}
							onChange={(event) => setName(event.target.value)}
							aria-invalid={error ? true : undefined}
							aria-describedby={error ? "renameFolderError" : undefined}
						/>
						{error && (
							<p id="renameFolderError" role="alert" className="text-sm text-red-600">
								{error}
							</p>
						)}
					</div>
					<div className="flex justify-end gap-2">
						<Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button type="submit" disabled={saving || !name.trim()}>
							{saving ? "Saving..." : "Rename"}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function DeleteFolderBody({ folder, open, onOpenChange, onDeleted }: DialogProps & { onDeleted: () => void }) {
	const [usage, setUsage] = useState<FolderUsage | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);
	const [moveTo, setMoveTo] = useState<FolderMoveTarget>("archive");
	const [error, setError] = useState<string | null>(null);
	const [deleting, setDeleting] = useState(false);

	useEffect(() => {
		let cancelled = false;
		void fetchFolderUsage(folder.id).then((result) => {
			if (cancelled) return;
			setUsage(result);
			setLoadFailed(!result);
		});
		return () => {
			cancelled = true;
		};
	}, [folder.id]);

	const importActive = (usage?.activeImports ?? 0) > 0;

	async function confirm(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!usage || importActive || deleting) return;
		setDeleting(true);
		setError(null);
		const result = await deleteFolderRequest(folder.id, usage.messageCount > 0 ? moveTo : undefined);
		setDeleting(false);
		if (!result.ok) {
			setError(result.error);
			return;
		}
		onOpenChange(false);
		onDeleted();
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				overlayClassName={ABOVE_SHEET}
				className={`${ABOVE_SHEET} max-h-[calc(100vh-4rem)] overflow-y-auto`}
			>
				<DialogHeader>
					<DialogTitle>Delete folder {folder.name}?</DialogTitle>
					<DialogDescription>
						{usage
							? folderDeleteSummary(usage)
							: loadFailed
								? "Could not check what is in this folder."
								: "Checking..."}
					</DialogDescription>
				</DialogHeader>
				<form onSubmit={confirm} className="space-y-4">
					{usage && usage.messageCount > 0 && !importActive && (
						<fieldset className="space-y-2">
							<legend className="text-sm font-medium text-neutral-900">What happens to the messages</legend>
							{FOLDER_MOVE_TARGETS.map((target) => (
								<label key={target} className="flex cursor-pointer items-center gap-2 text-sm text-neutral-700">
									<input
										type="radio"
										name="deleteFolderMoveTo"
										value={target}
										checked={moveTo === target}
										onChange={() => setMoveTo(target)}
										className="h-4 w-4 accent-blue-600"
									/>
									Move messages to {FOLDER_MOVE_LABELS[target]}
								</label>
							))}
						</fieldset>
					)}
					{importActive && (
						<p role="alert" className="text-sm text-amber-700">
							An import is still filing mail into this folder. Cancel or finish it on the Import page first.
						</p>
					)}
					{error && (
						<p role="alert" className="text-sm text-red-600">
							{error}
						</p>
					)}
					<div className="flex justify-end gap-2">
						<Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button type="submit" variant="destructive" disabled={!usage || importActive || deleting}>
							{deleting ? "Deleting..." : "Delete folder"}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
