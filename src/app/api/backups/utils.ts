import type { BackupSettingsInput } from "./types";
import type { BackupTableGroupId } from "@/lib/backups/types";
import { BACKUP_TABLE_GROUPS } from "@/lib/backups/table-groups";

const SCHEDULE_TYPES = new Set(["daily", "weekly", "monthly"]);

const SCHEDULE_VALUE_RANGES: Record<string, [number, number]> = { weekly: [0, 6], monthly: [1, 28] };

/** The weekday (0-6) or day of the month (1-28) of a schedule, null for daily, undefined when out of range. */
function parseScheduleValue(scheduleType: string, value: unknown): number | null | undefined {
	const range = SCHEDULE_VALUE_RANGES[scheduleType];
	if (!range) return null;
	const day = Number(value);
	return Number.isInteger(day) && day >= range[0] && day <= range[1] ? day : undefined;
}

export function parseBackupSettingsInput(value: unknown): BackupSettingsInput | null {
	if (!value || typeof value !== "object") return null;
	const input = value as Record<string, unknown>;
	if (typeof input.enabled !== "boolean") return null;
	if (typeof input.scheduleType !== "string" || !SCHEDULE_TYPES.has(input.scheduleType)) return null;
	if (typeof input.retentionEnabled !== "boolean") return null;
	if (input.includeObjects !== undefined && typeof input.includeObjects !== "boolean") return null;
	if (!Array.isArray(input.excludedTableGroups)) return null;
	const groupIds = new Set<string>(BACKUP_TABLE_GROUPS.map((group) => group.id));
	const isGroupId = (id: unknown): id is BackupTableGroupId => typeof id === "string" && groupIds.has(id);
	if (!input.excludedTableGroups.every(isGroupId)) return null;
	const excludedTableGroups: BackupSettingsInput["excludedTableGroups"] = [...new Set(input.excludedTableGroups)];
	if (excludedTableGroups.length === BACKUP_TABLE_GROUPS.length) return null;

	const retentionDays = Number(input.retentionDays);
	if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) return null;

	const scheduleValue = parseScheduleValue(input.scheduleType, input.scheduleValue);
	if (scheduleValue === undefined) return null;

	return {
		enabled: input.enabled,
		scheduleType: input.scheduleType as BackupSettingsInput["scheduleType"],
		scheduleValue,
		retentionEnabled: input.retentionEnabled,
		retentionDays,
		excludedTableGroups,
		includeObjects: input.includeObjects === true,
	};
}
