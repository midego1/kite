"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, DatabaseBackup } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { BackupHealth } from "@/lib/backups/health-types";
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

/** The latest successful backup and a warning when the latest run failed (docs/operations.md#backup-health). */
export function AdminBackupHealthCard() {
	const [health, setHealth] = useState<BackupHealth | null>(null);

	useEffect(() => {
		let active = true;
		fetch("/api/backups/health", { cache: "no-store" })
			.then((response) => (response.ok ? (response.json() as Promise<BackupHealth>) : null))
			.then((next) => {
				if (active) setHealth(next);
			})
			.catch(() => undefined);
		return () => {
			active = false;
		};
	}, []);

	if (!health) return null;
	const { lastSuccess, lastFailure } = health;
	const warn = health.level !== "ok";
	return (
		<Card data-testid="backup-health-card" data-level={health.level}>
			<CardHeader className="flex-row items-center gap-4 space-y-0">
				<div
					className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border ${
						warn
							? "border-[#ef4444]/25 bg-[#ef4444]/10 text-[#b91c1c] dark:text-[#f19999]"
							: "border-neutral-200 bg-[#f6f8fc] text-neutral-600"
					}`}
				>
					{warn ? <AlertTriangle className="h-5 w-5" /> : <DatabaseBackup className="h-5 w-5" />}
				</div>
				<div className="min-w-0">
					<CardTitle className="text-base">Backups</CardTitle>
					<p className="mt-1 text-sm text-neutral-500">
						{lastSuccess
							? `Last successful backup ${formatWhen(lastSuccess.completedAt)}${
									lastSuccess.size === null ? "" : `, ${formatDatabaseBytes(lastSuccess.size)}`
								}${lastSuccess.durationMs === null ? "" : `, took ${formatBackupDuration(lastSuccess.durationMs)}`}`
							: "No successful backup yet."}
					</p>
				</div>
			</CardHeader>
			<CardContent className="space-y-2 pt-4 text-sm">
				{lastFailure && (
					<p role="alert" className="text-[#b91c1c] dark:text-[#f19999]">
						The last backup failed {formatWhen(lastFailure.failedAt)}
						{lastFailure.error ? `: ${lastFailure.error}` : "."}
					</p>
				)}
				{health.inProgress && <p className="text-neutral-500">A backup is running now.</p>}
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
