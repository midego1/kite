import type { MigrationStatusResponse } from "./admin-update-card-types";

export async function getMigrationStatus(): Promise<MigrationStatusResponse> {
	const response = await fetch("/api/admin/migrations", { cache: "no-store" });
	const data = (await response.json()) as MigrationStatusResponse;
	if (!response.ok) throw new Error(data.error ?? "Could not check database migrations");
	return data;
}

export async function applyDatabaseMigrations(): Promise<MigrationStatusResponse> {
	const response = await fetch("/api/admin/migrations", { method: "POST" });
	const data = (await response.json()) as MigrationStatusResponse;
	if (!response.ok) throw new Error(data.error ?? "Could not apply database migrations");
	return data;
}

/** The heading of the pending-updates panel on the admin overview. */
export function pendingMigrationsTitle(count: number): string {
	return count === 1 ? "1 database update is waiting" : `${count} database updates are waiting`;
}
