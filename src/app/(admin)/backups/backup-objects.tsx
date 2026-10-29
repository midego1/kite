"use client";

import { useQuery } from "@tanstack/react-query";
import { FolderInput } from "lucide-react";
import { Button } from "@/components/ui/button";
import { requestConfirmation } from "@/components/ui/confirm-dialog-utils";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { BackupItem } from "./types";
import { fetchObjectsEstimate, formatBackupSize } from "./utils";

/** The opt-in for full backups, with the size they would add shown before one runs. */
export function BackupObjectsSetting({
	checked,
	disabled,
	onCheckedChange,
}: {
	checked: boolean;
	disabled: boolean;
	onCheckedChange: (checked: boolean) => void;
}) {
	const estimate = useQuery({ queryKey: ["backups", "objects-estimate"], queryFn: fetchObjectsEstimate });
	return (
		<div className="grid gap-2 border-t border-neutral-200 pt-5">
			<div className="flex items-center justify-between gap-4">
				<Label htmlFor="include-objects-switch">Include mail files</Label>
				<Switch id="include-objects-switch" checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
			</div>
			<p className="text-sm text-neutral-500" data-testid="backup-objects-estimate">
				Also copies raw mail, attachments and large message bodies next to every backup, so a restore can bring them
				back.{" "}
				{estimate.data
					? `About ${estimate.data.objects.toLocaleString()} files, ${formatBackupSize(estimate.data.bytes)} per backup.`
					: estimate.isError
						? "The size could not be estimated."
						: "Estimating the size..."}
			</p>
		</div>
	);
}

function objectsText(backup: BackupItem): string | null {
	const files = `${(backup.objectsCount ?? 0).toLocaleString()} mail files, ${formatBackupSize(backup.objectsSize ?? 0)}`;
	if (backup.objectsStatus === "copying") return `Copying mail files: ${files} so far`;
	if (backup.objectsStatus === "restoring") return `Restoring mail files (${files})`;
	if (backup.objectsStatus === "failed") return "Copying the mail files failed";
	if (backup.objectsStatus !== "completed") return null;
	const missing = backup.objectsMissing ? `, ${backup.objectsMissing.toLocaleString()} missing` : "";
	return `With ${files}${missing}`;
}

/** What a full backup holds besides the database, under its file name. */
export function BackupObjectsSummary({ backup }: { backup: BackupItem }) {
	const text = objectsText(backup);
	if (!text) return null;
	return <p className="truncate text-xs text-neutral-500">{text}</p>;
}

export function RestoreObjectsButton({
	backup,
	disabled,
	onRestore,
}: {
	backup: BackupItem;
	disabled: boolean;
	onRestore: (id: string) => void;
}) {
	if (backup.objectsStatus !== "completed" && backup.objectsStatus !== "restoring") return null;
	return (
		<Button
			size="sm"
			variant="ghost"
			title="Restore mail files"
			disabled={disabled || backup.objectsStatus !== "completed"}
			onClick={async () => {
				const confirmed = await requestConfirmation({
					title: "Restore the mail files of this backup?",
					description:
						"Raw mail, attachments and message bodies that are missing from storage are copied back from this backup. Files that exist are left alone. Restore the database first if you are recovering this backup as a whole.",
					confirmLabel: "Restore files",
				});
				if (confirmed) onRestore(backup.id);
			}}
		>
			<FolderInput className="h-4 w-4" />
		</Button>
	);
}
