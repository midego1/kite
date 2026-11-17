import type { MigrationApplyResponse, PendingMigrationsResponse } from "./migrations-banner-types";

export const PENDING_MIGRATIONS_REFRESH_MS = 5 * 60_000;

function parseApplier(value: unknown): PendingMigrationsResponse["appliedBy"] {
	if (!value || typeof value !== "object") return undefined;
	const { name, email } = value as Record<string, unknown>;
	if (typeof email !== "string" || !email.trim()) return undefined;
	return { name: typeof name === "string" ? name.trim() : "", email: email.trim() };
}

/**
 * Accepts only a count, names for the primary admin and the primary admin for other admins;
 * anything unexpected reads as up to date.
 */
export function parsePendingMigrations(value: unknown): PendingMigrationsResponse {
	const data = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	const pending =
		typeof data.pending === "number" && Number.isFinite(data.pending) ? Math.max(0, Math.floor(data.pending)) : 0;
	if (pending === 0) return { pending };
	const names = Array.isArray(data.names) ? data.names.filter((name): name is string => typeof name === "string") : [];
	const appliedBy = parseApplier(data.appliedBy);
	return { pending, ...(names.length ? { names } : {}), ...(appliedBy ? { appliedBy } : {}) };
}

/** The primary admin as "Name (email)", or just the address when there is no distinct name. */
export function migrationApplierWho(appliedBy: PendingMigrationsResponse["appliedBy"]): string | null {
	if (!appliedBy) return null;
	return appliedBy.name && appliedBy.name !== appliedBy.email
		? `${appliedBy.name} (${appliedBy.email})`
		: appliedBy.email;
}

/** Who to ask, for an account that cannot apply the updates itself. */
export function migrationApplierText(appliedBy: PendingMigrationsResponse["appliedBy"]): string {
	const who = migrationApplierWho(appliedBy);
	return who ? `Only the primary admin, ${who}, can apply them.` : "Ask an administrator to apply them.";
}

/**
 * A pending migration is the only reason to show this banner. A status that
 * could not be read at all stays quiet rather than warning about nothing.
 */
export function shouldShowMigrationsBanner(status: PendingMigrationsResponse | undefined): boolean {
	return (status?.pending ?? 0) > 0;
}

/** What to show after the primary admin presses Apply now. */
export function migrationApplySummary(result: MigrationApplyResponse): string {
	const applied = result.applied?.length ?? 0;
	const updated = `${applied} database ${applied === 1 ? "update" : "updates"} applied.`;
	return result.backupId ? `${updated} A safety backup was saved first.` : updated;
}
