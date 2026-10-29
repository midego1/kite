"use client";

import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { requestConfirmation } from "@/components/ui/confirm-dialog-utils";
import type { BackupItem } from "./types";

/** Restores a completed backup straight from storage, which works for backups too large to download and upload. */
export function RestoreStoredBackupButton({
	backup,
	disabled,
	onRestore,
}: {
	backup: BackupItem;
	disabled: boolean;
	onRestore: (id: string) => void;
}) {
	return (
		<Button
			size="sm"
			variant="ghost"
			title="Restore this backup"
			disabled={disabled || backup.status !== "completed"}
			onClick={async () => {
				const confirmed = await requestConfirmation({
					title: "Restore this backup?",
					description:
						"This replaces all current database records with this backup and may sign you out. A backup of the current data is saved first, and the restore is rolled back if it fails.",
					confirmLabel: "Restore",
				});
				if (confirmed) onRestore(backup.id);
			}}
		>
			<RotateCcw className="h-4 w-4" />
		</Button>
	);
}
