import type { BackupHealth } from "@/lib/backups/health-types";

/** Shared by the backup health card and the overview, so the page asks once. */
export const BACKUP_HEALTH_QUERY = ["backup-health"] as const;

export async function fetchBackupHealth(): Promise<BackupHealth | null> {
	const response = await fetch("/api/backups/health", { cache: "no-store" });
	return response.ok ? ((await response.json()) as BackupHealth) : null;
}
