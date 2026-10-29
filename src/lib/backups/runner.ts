import { and, eq, inArray, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { backups } from "@/db/schema/backups";
import { selectRows } from "@/lib/db/pending-columns";
import { createLogger } from "@/lib/logger.mjs";
import { writeBackupObject } from "./backup-writer";
import { streamDatabaseRecords } from "./export";
import {
	clearBackupObjectsPending,
	markBackupObjectsCopyFailed,
	markBackupObjectsPending,
	queueBackupObjectsDelete,
	startBackupObjectsCopy,
} from "./objects";
import { createScheduledBackupIfDue, failBackupRecord, getBackupSettings, isObjectsRunActive } from "./service";
import { BACKUP_PREFIX, createBackupFilename } from "./utils";

const log = createLogger("backups");

export async function runDatabaseBackup(env: CloudflareEnv, backupId: string): Promise<void> {
	const db = getDb(env);
	const [existing] = await db.select({ status: backups.status }).from(backups).where(eq(backups.id, backupId)).limit(1);
	// A retried queue message must not export the database twice, and a deleted
	// record has nowhere to write to.
	if (!existing || existing.status === "completed") return;
	const startedAt = new Date();
	let includeObjects = false;
	try {
		await db.update(backups).set({ status: "running", startedAt }).where(eq(backups.id, backupId));

		const settings = await getBackupSettings(env);
		includeObjects = settings?.includeObjects === true;
		if (includeObjects) await markBackupObjectsPending(env, backupId);
		const chunks = await streamDatabaseRecords(env.DB, settings?.excludedTableGroups ?? []);
		const filename = createBackupFilename(new Date());
		const r2Key = `${BACKUP_PREFIX}/${backupId}/${filename}`;
		const object = await writeBackupObject(env.BUCKET, r2Key, chunks, {
			httpMetadata: { contentType: "application/json" },
			customMetadata: { backupId },
		});

		await db
			.update(backups)
			.set({
				status: "completed",
				filename,
				r2Key,
				size: object.size,
				completedAt: new Date(),
				error: null,
			})
			.where(eq(backups.id, backupId));
	} catch (error) {
		const message = error instanceof Error ? error.message : "Backup failed";
		await failBackupRecord(env, backupId, message);
		if (includeObjects) await clearBackupObjectsPending(env, backupId).catch(() => undefined);
		throw error;
	}
	await afterBackup(env, backupId, includeObjects, startedAt);
}

/**
 * The database backup is complete and usable before these run, so their failures never mark it failed (and a
 * retried message never exports it again): a copy that cannot start is marked failed on its own and can be retried
 * from the Backups page, and retention runs again with the next backup or the daily cron.
 */
async function afterBackup(env: CloudflareEnv, backupId: string, includeObjects: boolean, startedAt: Date) {
	if (includeObjects) {
		try {
			await startBackupObjectsCopy(env, backupId, startedAt);
		} catch (error) {
			log.warn("backup.objects_start_failed", { backupId, error });
			await markBackupObjectsCopyFailed(env, backupId);
		}
	}
	try {
		await deleteExpiredBackups(env);
	} catch (error) {
		log.warn("backup.retention_failed", { backupId, error });
	}
}

export async function runScheduledDatabaseBackup(env: CloudflareEnv, now: Date): Promise<void> {
	const backupId = await createScheduledBackupIfDue(env, now);
	if (backupId) {
		await runDatabaseBackup(env, backupId);
		return;
	}
	await deleteExpiredBackups(env);
}

export async function deleteExpiredBackups(env: CloudflareEnv): Promise<number> {
	const settings = await getBackupSettings(env);
	if (!settings?.retentionEnabled) return 0;

	const cutoff = new Date(Date.now() - settings.retentionDays * 86_400_000);
	const db = getDb(env);
	const expired = (
		await selectRows(db, backups, and(lt(backups.createdAt, cutoff), inArray(backups.status, ["completed", "failed"])))
	).filter((backup) => !isObjectsRunActive(backup));
	for (const backup of expired) {
		if (backup.r2Key) await env.BUCKET.delete(backup.r2Key);
		await db.delete(backups).where(eq(backups.id, backup.id));
		await queueBackupObjectsDelete(env, backup.objectsPrefix);
	}
	return expired.length;
}
