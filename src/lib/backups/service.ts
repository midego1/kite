import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { backups, backupSettings } from "@/db/schema/backups";
import { missingColumnFromError } from "@/lib/auth/user-lookup-utils";
import { selectRow, selectRows } from "@/lib/db/pending-columns";
import { newId } from "@/lib/ids";
import { queueBackupObjectsDelete, startPendingBackupObjectsCopies } from "./objects";
import type { BackupObjectsRestoreResult } from "./objects-types";
import { isStaleObjectsRun, parseObjectsRun, STALE_OBJECTS_ERROR } from "./objects-utils";
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
 * Marks backups that stopped making progress as failed, and starts the mail file copies of full backups whose
 * runner stopped between the export and the copy. A killed invocation
 * never reaches the runner's own error handler, so without this a manual backup
 * would sit in "running" forever and refuse deletion. Runs from the five-minute
 * maintenance cron and from the list endpoint, so the admin page heals itself.
 */
export async function failStaleBackups(env: CloudflareEnv, now = new Date()): Promise<number> {
	const db = getDb(env);
	const unfinished = await selectRows(db, backups, inArray(backups.status, ["queued", "running"]));
	const stale = unfinished.filter((backup) => isStaleBackup(backup, now));
	for (const backup of stale) await failBackupRecord(env, backup.id, STALE_BACKUP_ERROR);
	return stale.length + (await failStaleObjectRuns(env, now)) + (await startPendingBackupObjectsCopies(env, now));
}

/**
 * The same for copies and restores of a full backup's mail objects. An interrupted copy is failed (its database
 * backup stays usable, and Retry resumes it from its saved position); an interrupted restore goes back to completed
 * with what it did so far, so it can be started again.
 */
async function failStaleObjectRuns(env: CloudflareEnv, now: Date): Promise<number> {
	let running;
	try {
		running = await getDb(env)
			.select({
				id: backups.id,
				objectsStatus: backups.objectsStatus,
				objectsUpdatedAt: backups.objectsUpdatedAt,
				objectsCursor: backups.objectsCursor,
			})
			.from(backups)
			.where(inArray(backups.objectsStatus, ["copying", "restoring"]));
	} catch (error) {
		// Before migration 0081 no backup has objects.
		if (missingColumnFromError(error)) return 0;
		throw error;
	}
	const stale = running.filter((backup) => isStaleObjectsRun(backup, now));
	for (const backup of stale) {
		const run = parseObjectsRun(backup.objectsCursor);
		const result: BackupObjectsRestoreResult | null =
			run?.run === "restore"
				? {
						restored: run.restored,
						present: run.present,
						failed: run.failed,
						finishedAt: now.toISOString(),
						interrupted: true,
					}
				: null;
		await env.DB.prepare(
			`UPDATE backups SET objects_status = ?, error = coalesce(?, error), objects_restore = coalesce(?, objects_restore)
			 WHERE id = ? AND objects_status = ? AND coalesce(objects_cursor, '') = ?`,
		)
			.bind(
				backup.objectsStatus === "copying" ? "failed" : "completed",
				backup.objectsStatus === "copying" ? STALE_OBJECTS_ERROR : null,
				result ? JSON.stringify(result) : null,
				backup.id,
				backup.objectsStatus,
				backup.objectsCursor ?? "",
			)
			.run();
	}
	return stale.length;
}

export async function createBackupRecord(
	env: CloudflareEnv,
	trigger: "manual" | "scheduled",
	createdByUserId?: string,
) {
	const id = newId("bak");
	// Only the columns of migration 0009: a Drizzle insert lists every column of the schema, so before migration 0081
	// it would name the objects_* columns and fail, stopping manual and scheduled backups alike.
	await env.DB.prepare(
		"INSERT INTO backups (id, status, `trigger`, created_by_user_id, created_at) VALUES (?, 'queued', ?, ?, ?)",
	)
		.bind(id, trigger, createdByUserId ?? null, Math.floor(Date.now() / 1000))
		.run();
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
	const save = (values: Partial<typeof backupSettings.$inferInsert>) =>
		getDb(env)
			.update(backupSettings)
			.set({ ...values, excludedTableGroups: JSON.stringify(excludedTableGroups), updatedAt: new Date() })
			.where(eq(backupSettings.id, BACKUP_SETTINGS_ID));
	try {
		await save({ ...settings, includeObjects });
	} catch (error) {
		if (missingColumnFromError(error) !== "include_objects") throw error;
		// Before migration 0081 the switch cannot be on; everything else still saves, in one statement.
		if (includeObjects) throw new Error("Apply pending database migrations before backing up mail files.");
		await save(settings);
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
