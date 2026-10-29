"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { requestConfirmation } from "@/components/ui/confirm-dialog-utils";
import { recoverPreviousData } from "@/app/(admin)/backups/utils";
import type { RestoreSummary } from "@/lib/backups/restore-job-types";
import { restoreOutcomeText } from "@/lib/backups/restore-job-utils";
import { formatUserDate } from "@/lib/time/utils";

const ALERT = "text-[#b91c1c] dark:text-[#f19999]";

/**
 * The latest restore on the admin overview: running, finished, or failed. One that could not be rolled back offers
 * to restore the safety backup taken before it (docs/operations.md#backup-health).
 */
export function AdminBackupRestoreStatus({ restore }: { restore: RestoreSummary | null | undefined }) {
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const router = useRouter();
	if (!restore) return null;
	if (restore.active) return <p className="text-neutral-500">A restore is running now.</p>;
	if (restore.status === "completed")
		return (
			<p className="text-neutral-500">
				The last restore finished{" "}
				{formatUserDate(restore.finishedAt ?? restore.createdAt, { dateStyle: "medium", timeStyle: "short" })}.
			</p>
		);
	const recover = async () => {
		const confirmed = await requestConfirmation({
			title: "Restore the previous data?",
			description:
				"This restores the backup taken right before the failed restore and may sign you out. A backup of the current data is saved first.",
			confirmLabel: "Restore",
		});
		if (!confirmed) return;
		setPending(true);
		setError(null);
		try {
			await recoverPreviousData();
			// The Backups page picks up the running restore and follows it.
			router.push("/backups");
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Failed to restore backup");
			setPending(false);
		}
	};
	return (
		<div role="alert" data-testid="restore-status" className={`space-y-2 ${ALERT}`}>
			<p>{restoreOutcomeText(restore)}</p>
			{restore.needsRecovery && restore.safetyBackup && (
				<>
					<p>{`The data from before the restore is in the backup ${restore.safetyBackup.filename ?? restore.safetyBackup.id}.`}</p>
					<Button size="sm" variant="outline" disabled={pending} onClick={() => void recover()}>
						<RotateCcw className="h-4 w-4" />
						{pending ? "Starting..." : "Restore previous data"}
					</Button>
				</>
			)}
			{error && <p>{error}</p>}
		</div>
	);
}
