import { canManageUsers, isPrimaryAdmin } from "@/lib/auth/admin";
import type { SessionUser } from "@/lib/auth/types";

export type QuotaActor = Pick<SessionUser, "id" | "role" | "isPrimaryAdmin" | "canManageUsers">;

/**
 * The limit that applies to an owner: their override row when one exists (whose null means unlimited for
 * them), otherwise the install default (null, or no settings row, means unlimited).
 */
export function effectiveQuota(
	override: { quotaBytes: number | null } | undefined,
	defaultQuota: number | null,
): number | null {
	if (override) return override.quotaBytes;
	return defaultQuota;
}

/** Whether `size` more bytes fit; the same rule the reserving insert applies in SQL. */
export function fitsQuota(used: number, size: number, limit: number | null): boolean {
	return limit === null || used + size <= limit;
}

export const QUOTA_ERROR = "Not enough Drive storage left for this file";

/** A quota in bytes from a request body: null is unlimited, a non-negative whole number is a limit, anything else undefined. */
export function parseQuotaBytes(value: unknown): number | null | undefined {
	if (value === null) return null;
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** The same rule as account editing: the primary admin changes anyone, a user manager only plain users. */
export function mayChangeQuota(actor: QuotaActor, account: { role: string; isPrimaryAdmin: boolean }): boolean {
	return isPrimaryAdmin(actor) || (canManageUsers(actor) && account.role === "user" && !account.isPrimaryAdmin);
}
