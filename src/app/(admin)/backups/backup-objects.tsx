"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FolderInput, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { requestConfirmation } from "@/components/ui/confirm-dialog-utils";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { keptFullBackupCopies } from "@/lib/backups/objects-utils";
import type { BackupItem, BackupSettings } from "./types";
import { fetchObjectsEstimate, formatBackupSize, parseObjectsRestore } from "./utils";

function copiesText(settings: BackupSettings, bytes: number | null): string {
	const copies = keptFullBackupCopies(settings);
	if (copies === null) return "Backups are kept until you delete them, so the space grows with every full backup.";
	const total = bytes === null ? "" : `, about ${formatBackupSize(bytes * copies)} in total`;
	return `Every full backup holds its own copy, nothing is shared between backups: with this schedule and retention about ${copies} ${copies === 1 ? "copy is" : "copies are"} kept at once${total}.`;
}

/**
 * The opt-in for full backups. The size is estimated only when asked for or while the switch is on, so opening the
 * Backups page never makes the database count every message.
 */
export function BackupObjectsSetting({
	settings,
	disabled,
	onCheckedChange,
}: {
	settings: BackupSettings;
	disabled: boolean;
	onCheckedChange: (checked: boolean) => void;
}) {
	const [requested, setRequested] = useState(false);
	const estimate = useQuery({
		queryKey: ["backups", "objects-estimate"],
		queryFn: fetchObjectsEstimate,
		enabled: requested || settings.includeObjects,
		staleTime: 5 * 60 * 1000,
	});
	let size: React.ReactNode;
	if (estimate.data)
		size = `About ${estimate.data.objects.toLocaleString()} files, ${formatBackupSize(estimate.data.bytes)} per backup. ${copiesText(settings, estimate.data.bytes)}`;
	else if (estimate.isError) size = "The size could not be estimated.";
	else if (estimate.isFetching) size = "Estimating the size...";
	else
		size = (
			<Button
				type="button"
				variant="ghost"
				className="h-auto p-0 text-sm font-medium text-neutral-900 underline underline-offset-2 hover:bg-transparent"
				onClick={() => setRequested(true)}
			>
				Estimate the size
			</Button>
		);
	return (
		<div className="grid gap-2 border-t border-neutral-200 pt-5">
			<div className="flex items-center justify-between gap-4">
				<Label htmlFor="include-objects-switch">Include mail files</Label>
				<Switch
					id="include-objects-switch"
					checked={settings.includeObjects}
					disabled={disabled}
					onCheckedChange={onCheckedChange}
				/>
			</div>
			<p className="text-sm text-neutral-500" data-testid="backup-objects-estimate">
				Also copies raw mail, attachments and large message bodies next to every backup, so a restore can bring them
				back. {size}
			</p>
		</div>
	);
}

function copyText(backup: BackupItem): { text: string; failed: boolean } | null {
	const files = `${(backup.objectsCount ?? 0).toLocaleString()} mail files, ${formatBackupSize(backup.objectsSize ?? 0)}`;
	// Pending on a finished export: the copy starts within minutes (from the five-minute check if not at once).
	if (backup.objectsStatus === "pending" && backup.status === "completed")
		return { text: "Waiting to copy the mail files", failed: false };
	if (backup.objectsStatus === "copying") return { text: `Copying mail files: ${files} so far`, failed: false };
	if (backup.objectsStatus === "restoring") return { text: `Restoring mail files (${files})`, failed: false };
	if (backup.objectsStatus === "failed")
		return { text: `Copying the mail files failed${backup.error ? `: ${backup.error}` : ""}`, failed: true };
	if (backup.objectsStatus !== "completed") return null;
	const missing = backup.objectsMissing ? `, ${backup.objectsMissing.toLocaleString()} missing` : "";
	const failed = backup.objectsFailed ? `, ${backup.objectsFailed.toLocaleString()} could not be copied` : "";
	return { text: `With ${files}${missing}${failed}`, failed: !!backup.objectsFailed };
}

function restoreText(backup: BackupItem): { text: string; failed: boolean } | null {
	const result = parseObjectsRestore(backup.objectsRestore);
	if (!result || backup.objectsStatus === "restoring") return null;
	const parts = [`${result.restored.toLocaleString()} restored`, `${result.present.toLocaleString()} already there`];
	if (result.failed) parts.push(`${result.failed.toLocaleString()} failed`);
	return {
		text: `Last restore of mail files${result.interrupted ? " (interrupted)" : ""}: ${parts.join(", ")}`,
		failed: result.failed > 0 || !!result.interrupted,
	};
}

/** What a full backup holds besides the database, and how its last restore of files went, under its file name. */
export function BackupObjectsSummary({ backup }: { backup: BackupItem }) {
	const lines = [copyText(backup), restoreText(backup)].filter((line) => line !== null);
	return lines.map((line) => (
		<p
			key={line.text}
			title={line.text}
			className={`truncate text-xs ${line.failed ? "text-red-700" : "text-neutral-500"}`}
		>
			{line.text}
		</p>
	));
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

/** Copies the files again after a failed copy, or one that finished with files it could not copy. */
export function RetryObjectsButton({
	backup,
	disabled,
	onRetry,
}: {
	backup: BackupItem;
	disabled: boolean;
	onRetry: (id: string) => void;
}) {
	const retryable =
		backup.objectsStatus === "failed" || (backup.objectsStatus === "completed" && (backup.objectsFailed ?? 0) > 0);
	if (!retryable) return null;
	return (
		<Button
			size="sm"
			variant="ghost"
			title="Retry copying mail files"
			disabled={disabled}
			onClick={() => onRetry(backup.id)}
		>
			<RefreshCw className="h-4 w-4" />
		</Button>
	);
}
