"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { AlertTriangle, DatabaseBackup } from "lucide-react";
import { ERROR_TEXT_CLASS } from "@/components/notice-styles";
import { Card, CardContent, CardTitleRow } from "@/components/ui/card";
import { AdminBackupRestoreStatus } from "@/components/admin-backup-restore-status";
import type { BackupHealth } from "@/lib/backups/health-types";
import { BACKUP_HEALTH_QUERY, fetchBackupHealth } from "./admin-backup-health-query";
import { formatBackupDuration } from "@/lib/backups/health-utils";
import { formatDatabaseBytes } from "@/lib/db/size-utils";
import { formatUserDate } from "@/lib/time/utils";

const SCHEDULES: Record<string, string> = { daily: "daily", weekly: "weekly", monthly: "monthly" };

function formatWhen(value: string): string {
	return formatUserDate(value, { dateStyle: "medium", timeStyle: "short" });
}

function scheduleText(automatic: BackupHealth["automatic"]): string {
	if (!automatic?.enabled) return "Automatic backups are off.";
	const schedule = SCHEDULES[automatic.scheduleType] ?? automatic.scheduleType;
	return automatic.retentionEnabled
		? `Automatic backups run ${schedule} and are kept for ${automatic.retentionDays} days.`
		: `Automatic backups run ${schedule} and are kept until you delete them.`;
}

/**
 * The latest successful backup, a warning when the latest run failed, and the latest restore
 * (docs/operations.md#backup-health).
 */
export function AdminBackupHealthCard() {
	// The overview's attention list reads the same query, so the page asks the server once.
	const { data: health } = useQuery({ queryKey: BACKUP_HEALTH_QUERY, queryFn: fetchBackupHealth, retry: false });

	if (!health) return null;
	const { lastSuccess, lastFailure } = health;
	const warn = health.level !== "ok" || !!health.restore?.needsRecovery;
	return (
		<Card data-testid="backup-health-card" data-level={health.level}>
			<CardTitleRow
				icon={warn ? AlertTriangle : DatabaseBackup}
				tone={warn ? "critical" : "neutral"}
				title="Backups"
				description={
					lastSuccess
						? `Last successful backup ${formatWhen(lastSuccess.completedAt)}${
								lastSuccess.size === null ? "" : `, ${formatDatabaseBytes(lastSuccess.size)}`
							}${lastSuccess.durationMs === null ? "" : `, took ${formatBackupDuration(lastSuccess.durationMs)}`}`
						: "No successful backup yet."
				}
			/>
			<CardContent className="space-y-2 pt-4 text-sm">
				{lastFailure && (
					<p role="alert" className={ERROR_TEXT_CLASS}>
						The last backup failed {formatWhen(lastFailure.failedAt)}
						{lastFailure.error ? `: ${lastFailure.error}` : "."}
					</p>
				)}
				{health.inProgress && <p className="text-neutral-500">A backup is running now.</p>}
				<AdminBackupRestoreStatus restore={health.restore} />
				<p className="text-neutral-500">
					{scheduleText(health.automatic)}{" "}
					<Link href="/backups" className="font-medium text-neutral-900 underline underline-offset-2">
						Open Backups
					</Link>
				</p>
			</CardContent>
		</Card>
	);
}
