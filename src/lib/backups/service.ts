import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { backups, backupSettings } from "@/db/schema";
import { newId } from "@/lib/ids";
import type { BackupScheduleType, BackupTableGroupId } from "./types";
import { BACKUP_SETTINGS_ID, STALE_BACKUP_ERROR, getUtcDayBounds, isBackupDue, isStaleBackup } from "./utils";
import { parseExcludedBackupTableGroups } from "./table-groups";

export async function getBackupSettings(env: CloudflareEnv) {
	const db = getDb(env);
	const [settings] = await db.select().from(backupSettings).where(eq(backupSettings.id, BACKUP_SETTINGS_ID)).limit(1);
	return settings
		? { ...settings, excludedTableGroups: parseExcludedBackupTableGroups(settings.excludedTableGroups) }
		: undefined;
}

export async function listBackups(env: CloudflareEnv) {
	return getDb(env).select().from(backups).orderBy(desc(backups.createdAt)).limit(100);
}

/** Records that a backup did not finish, whether it failed or was interrupted. */
export async function failBackupRecord(env: CloudflareEnv, id: string, error: string): Promise<void> {
	await getDb(env).update(backups).set({ status: "failed", error, completedAt: new Date() }).where(eq(backups.id, id));
}

/**
 * Marks backups that stopped making progress as failed. A killed invocation
 * never reaches the runner's own error handler, so without this a manual backup
 * would sit in "running" forever and refuse deletion. Runs from the five-minute
 * maintenance cron and from the list endpoint, so the admin page heals itself.
 */
export async function failStaleBackups(env: CloudflareEnv, now = new Date()): Promise<number> {
	const db = getDb(env);
	const unfinished = await db
		.select()
		.from(backups)
		.where(inArray(backups.status, ["queued", "running"]));
	const stale = unfinished.filter((backup) => isStaleBackup(backup, now));
	for (const backup of stale) await failBackupRecord(env, backup.id, STALE_BACKUP_ERROR);
	return stale.length;
}

export async function createBackupRecord(
	env: CloudflareEnv,
	trigger: "manual" | "scheduled",
	createdByUserId?: string,
) {
	const id = newId("bak");
	await getDb(env)
		.insert(backups)
		.values({
			id,
			trigger,
			createdByUserId: createdByUserId ?? null,
		});
	return id;
}

export async function createScheduledBackupIfDue(env: CloudflareEnv, now: Date): Promise<string | null> {
	const settings = await getBackupSettings(env);
	if (!settings?.enabled) return null;
	if (!isBackupDue(settings.scheduleType as BackupScheduleType, settings.scheduleValue, now)) return null;

	const { start, end } = getUtcDayBounds(now);
	const existing = await getDb(env)
		.select({ id: backups.id })
		.from(backups)
		.where(
			and(
				eq(backups.trigger, "scheduled"),
				inArray(backups.status, ["queued", "running", "completed"]),
				gte(backups.createdAt, new Date(start)),
				lt(backups.createdAt, new Date(end)),
			),
		)
		.limit(1);
	if (existing.length) return null;
	return createBackupRecord(env, "scheduled");
}

export async function updateBackupSettings(
	env: CloudflareEnv,
	input: {
		enabled: boolean;
		scheduleType: BackupScheduleType;
		scheduleValue: number | null;
		retentionEnabled: boolean;
		retentionDays: number;
		excludedTableGroups: BackupTableGroupId[];
	},
) {
	const { excludedTableGroups, ...settings } = input;
	await getDb(env)
		.update(backupSettings)
		.set({ ...settings, excludedTableGroups: JSON.stringify(excludedTableGroups), updatedAt: new Date() })
		.where(eq(backupSettings.id, BACKUP_SETTINGS_ID));
}

export async function deleteBackup(env: CloudflareEnv, id: string): Promise<boolean> {
	const db = getDb(env);
	const [backup] = await db.select().from(backups).where(eq(backups.id, id)).limit(1);
	if (!backup) return false;
	// An unfinished backup may still be writing to R2, so it is kept; an
	// interrupted one is never going to finish and can be removed like a failed
	// one. Listing marks it failed first, this check covers a direct delete.
	if (backup.status === "queued" || backup.status === "running") {
		if (!isStaleBackup(backup, new Date())) throw new Error("A backup in progress cannot be deleted");
	}
	if (backup.r2Key) await env.BUCKET.delete(backup.r2Key);
	await db.delete(backups).where(eq(backups.id, id));
	return true;
}
