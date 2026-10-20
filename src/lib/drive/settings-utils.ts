import { DRIVE_LINK_DEFAULT_MAX_DAYS, DRIVE_LINK_MAX_DAYS_LIMIT } from "./link-utils";
import { parseQuotaBytes } from "./quota-utils";
import type { DriveSettingsValues } from "./types";

export const DRIVE_DEFAULT_TRASH_DAYS = 30;
export const DRIVE_MAX_TRASH_DAYS = 365;

/** What an install without a `drive_settings` row gets. */
export const DEFAULT_DRIVE_SETTINGS: DriveSettingsValues = {
	defaultQuotaBytes: null,
	linkMaxDays: DRIVE_LINK_DEFAULT_MAX_DAYS,
	trashRetentionDays: DRIVE_DEFAULT_TRASH_DAYS,
};

const isWhole = (value: unknown, min: number, max: number): value is number =>
	typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

/**
 * Applies a `PATCH /api/drive/settings` body to the current values. Link lifetime is 0 (links off) or
 * 1-365 days and never unlimited; trash retention is 1-365 days; the default quota is bytes or null.
 */
export function applySettingsPatch(
	current: DriveSettingsValues,
	body: unknown,
): { settings: DriveSettingsValues } | { error: string } {
	if (!body || typeof body !== "object") return { error: "Invalid settings" };
	const patch = body as Record<string, unknown>;
	const next = { ...current };
	if ("defaultQuotaBytes" in patch) {
		const quota = parseQuotaBytes(patch.defaultQuotaBytes);
		if (quota === undefined) return { error: "The default quota must be a whole number of bytes or empty" };
		next.defaultQuotaBytes = quota;
	}
	if ("linkMaxDays" in patch) {
		if (!isWhole(patch.linkMaxDays, 0, DRIVE_LINK_MAX_DAYS_LIMIT))
			return { error: `Link lifetime must be 0 (links off) or 1 to ${DRIVE_LINK_MAX_DAYS_LIMIT} days` };
		next.linkMaxDays = patch.linkMaxDays;
	}
	if ("trashRetentionDays" in patch) {
		if (!isWhole(patch.trashRetentionDays, 1, DRIVE_MAX_TRASH_DAYS))
			return { error: `Trash retention must be 1 to ${DRIVE_MAX_TRASH_DAYS} days` };
		next.trashRetentionDays = patch.trashRetentionDays;
	}
	return { settings: next };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Items trashed at or before this moment are past the retention. */
export function trashCutoff(now: Date, retentionDays: number): Date {
	return new Date(now.getTime() - retentionDays * DAY_MS);
}
