import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { backups, backupSettings } from "@/db/schema/backups";
import { missingColumnFromError } from "@/lib/auth/user-lookup-utils";
import { selectRow, selectRows } from "@/lib/db/pending-columns";
import { newId } from "@/lib/ids";
import { queueBackupObjectsDelete } from "./objects";
import { isStaleObjectsRun, STALE_OBJECTS_ERROR } from "./objects-utils";
import type { BackupScheduleType, BackupTableGroupId } from "./types";
import { BACKUP_SETTINGS_ID, STALE_BACKUP_ERROR, getUtcDayBounds, isBackupDue, isStaleBackup } from "./utils";
import { parseExcludedBackupTableGroups } from "./table-groups";

export async function getBackupSettings(env: CloudflareEnv) {
	// Read column by column: include_objects only exists from migration 0081.
	const settings = await selectRow(getDb(env), backupSettings, eq(backupSettings.id, BACKUP_SETTINGS_ID));
	return settings
		? { ...settings, excludedTableGroups: parseExcludedBackupTableGroups(settings.excludedTableGroups) }
		: undefined;
}

export async function listBackups(env: CloudflareEnv) {
	return selectRows(getDb(env), backups, undefined, 100, desc(backups.createdAt));
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
	const unfinished = await selectRows(db, backups, inArray(backups.status, ["queued", "running"]));
	const stale = unfinished.filter((backup) => isStaleBackup(backup, now));
	for (const backup of stale) await failBackupRecord(env, backup.id, STALE_BACKUP_ERROR);
	return stale.length + (await failStaleObjectRuns(env, now));
}

/**
 * The same for copies and restores of a full backup's mail objects. An interrupted copy is failed (its database
 * backup stays usable); an interrupted restore goes back to completed, so it can be started again.
 */
async function failStaleObjectRuns(env: CloudflareEnv, now: Date): Promise<number> {
	const db = getDb(env);
	let running;
	try {
		running = await db
			.select({ id: backups.id, objectsStatus: backups.objectsStatus, objectsUpdatedAt: backups.objectsUpdatedAt })
			.from(backups)
			.where(inArray(backups.objectsStatus, ["copying", "restoring"]));
	} catch (error) {
		// Before migration 0081 no backup has objects.
		if (missingColumnFromError(error)) return 0;
		throw error;
	}
	const stale = running.filter((backup) => isStaleObjectsRun(backup, now));
	for (const backup of stale) {
		await db
			.update(backups)
			.set(
				backup.objectsStatus === "copying"
					? { objectsStatus: "failed", error: STALE_OBJECTS_ERROR }
					: { objectsStatus: "completed" },
			)
			.where(and(eq(backups.id, backup.id), eq(backups.objectsStatus, backup.objectsStatus!)));
	}
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
		includeObjects: boolean;
	},
) {
	const { excludedTableGroups, includeObjects, ...settings } = input;
	try {
		await getDb(env)
			.update(backupSettings)
			// Left out while off, so the other settings save before migration 0081 adds the column.
			.set({
				...settings,
				...(includeObjects ? { includeObjects } : {}),
				excludedTableGroups: JSON.stringify(excludedTableGroups),
				updatedAt: new Date(),
			})
			.where(eq(backupSettings.id, BACKUP_SETTINGS_ID));
	} catch (error) {
		if (missingColumnFromError(error) === "include_objects")
			throw new Error("Apply pending database migrations before backing up mail files.");
		throw error;
	}
	if (!includeObjects) await setIncludeObjectsOff(env);
}

async function setIncludeObjectsOff(env: CloudflareEnv): Promise<void> {
	try {
		await getDb(env)
			.update(backupSettings)
			.set({ includeObjects: false })
			.where(eq(backupSettings.id, BACKUP_SETTINGS_ID));
	} catch (error) {
		if (missingColumnFromError(error) !== "include_objects") throw error;
	}
}

export async function deleteBackup(env: CloudflareEnv, id: string): Promise<boolean> {
	const db = getDb(env);
	const backup = await selectRow(db, backups, eq(backups.id, id));
	if (!backup) return false;
	// An unfinished backup may still be writing to R2, so it is kept; an
	// interrupted one is never going to finish and can be removed like a failed
	// one. Listing marks it failed first, this check covers a direct delete.
	if (backup.status === "queued" || backup.status === "running") {
		if (!isStaleBackup(backup, new Date())) throw new Error("A backup in progress cannot be deleted");
	}
	if (isObjectsRunActive(backup) && !isStaleObjectsRun(backup, new Date()))
		throw new Error("Wait until the mail files of this backup are copied or restored");
	if (backup.r2Key) await env.BUCKET.delete(backup.r2Key);
	await db.delete(backups).where(eq(backups.id, id));
	await queueBackupObjectsDelete(env, backup.objectsPrefix);
	return true;
}

/** A copy or restore of the backup's mail objects is still running. */
export function isObjectsRunActive(backup: { objectsStatus: string | null }): boolean {
	return backup.objectsStatus === "copying" || backup.objectsStatus === "restoring";
}
