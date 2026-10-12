import type { MigrationApplyResponse, PendingMigrationsResponse } from "./migrations-banner-types";

export const PENDING_MIGRATIONS_REFRESH_MS = 5 * 60_000;

/** Accepts only a count and, for the primary admin, names; anything unexpected reads as up to date. */
export function parsePendingMigrations(value: unknown): PendingMigrationsResponse {
	const data = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	const pending =
		typeof data.pending === "number" && Number.isFinite(data.pending) ? Math.max(0, Math.floor(data.pending)) : 0;
	const names = Array.isArray(data.names) ? data.names.filter((name): name is string => typeof name === "string") : [];
	return pending > 0 && names.length ? { pending, names } : { pending };
}

/**
 * A pending migration is the only reason to show this banner. A status that
 * could not be read at all stays quiet rather than warning about nothing.
 */
export function shouldShowMigrationsBanner(status: PendingMigrationsResponse | undefined): boolean {
	return (status?.pending ?? 0) > 0;
}

/** The wording from the deploy notes: what changed and what is wrong until it is applied. */
export function migrationsBannerContent(pending: number): { title: string; body: string } {
	return {
		title: `Kite was updated, but the database still needs ${pending} ${pending === 1 ? "update" : "updates"}`,
		body: "Until they are applied, new email may not appear and some pages may fail.",
	};
}

/** What to show after the primary admin presses Apply now. */
export function migrationApplySummary(result: MigrationApplyResponse): string {
	const applied = result.applied?.length ?? 0;
	const updated = `${applied} database ${applied === 1 ? "update" : "updates"} applied.`;
	return result.backupId ? `${updated} A safety backup was saved first.` : updated;
}
