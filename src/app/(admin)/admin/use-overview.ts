"use client";

import { useQueries } from "@tanstack/react-query";
import { BACKUP_HEALTH_QUERY, fetchBackupHealth } from "@/components/admin-backup-health-query";
import { DATABASE_SIZE_QUERY, fetchDatabaseSize } from "@/components/admin-database-size-query";
import { fetchPendingMigrations, PENDING_MIGRATIONS_QUERY } from "@/components/use-migrations-notice";
import { fetchStorageReminder, STORAGE_OVERVIEW_KEY } from "@/components/storage/direct-uploads-reminder";
import { authFetch } from "@/lib/auth/client";
import type { AdminOverviewCounts } from "@/lib/admin/overview-types";
import type { OverviewData } from "./overview-types";

const OVERVIEW_COUNTS_QUERY = ["admin-overview-counts"] as const;

async function fetchOverviewCounts(): Promise<AdminOverviewCounts> {
	const response = await authFetch("/api/admin/overview", { cache: "no-store" });
	if (!response.ok) throw new Error(`Overview request failed (${response.status})`);
	return (await response.json()) as AdminOverviewCounts;
}

/**
 * The overview's parts, each under the query key its card or notice uses too, so one request serves both and an
 * update, backup or restore that invalidates the key refreshes the list as well. Primary-only parts are never
 * requested for other admins.
 */
export function useOverview(primary: boolean, enabled: boolean): { data: OverviewData; loading: boolean } {
	const shared = { enabled, staleTime: 30_000, refetchOnMount: "always" as const, retry: false };
	const [migrations, counts, databaseSize, backups, storage] = useQueries({
		queries: [
			{ queryKey: PENDING_MIGRATIONS_QUERY, queryFn: fetchPendingMigrations, ...shared },
			{ queryKey: OVERVIEW_COUNTS_QUERY, queryFn: fetchOverviewCounts, ...shared },
			{ queryKey: DATABASE_SIZE_QUERY, queryFn: fetchDatabaseSize, ...shared, enabled: enabled && primary },
			{ queryKey: BACKUP_HEALTH_QUERY, queryFn: fetchBackupHealth, ...shared, enabled: enabled && primary },
			// The Storage page's key, so dismissing the reminder in either place refreshes both.
			{ queryKey: STORAGE_OVERVIEW_KEY, queryFn: fetchStorageReminder, ...shared, enabled: enabled && primary },
		],
	});
	const loading = [migrations, counts, databaseSize, backups, storage].some((query) => query.isLoading);
	return {
		loading,
		data: {
			migrations: migrations.data ? { pending: migrations.data.pending } : null,
			counts: counts.data ?? null,
			databaseSize: databaseSize.data ?? null,
			backups: backups.data ?? null,
			directUploads: storage.data?.directUploadsReminder ?? null,
		},
	};
}
