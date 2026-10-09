import { newId } from "@/lib/ids";
import { writeBackupObject } from "./backup-writer";
import { streamDatabaseSnapshot } from "./export";
import type { RestoreStatement } from "./restore-types";
import type { SafetyBackup, SafetyBackupTrigger } from "./safety-types";
import { BACKUP_PREFIX, createBackupFilename } from "./utils";

/**
 * Saves a full snapshot to R2 before a restore or a migration changes the
 * database, and lists it on the Backups page. Written with plain SQL against
 * the original `backups` columns so it works on a database that has not been
 * migrated yet.
 */
export async function createSafetyBackup(
	env: CloudflareEnv,
	trigger: SafetyBackupTrigger,
	userId?: string | null,
): Promise<SafetyBackup> {
	const id = newId("bak");
	const startedAt = Math.floor(Date.now() / 1000);
	const chunks = await streamDatabaseSnapshot(env.DB);
	const filename = `${trigger}-${createBackupFilename(new Date())}`;
	const r2Key = `${BACKUP_PREFIX}/${id}/${filename}`;
	const object = await writeBackupObject(env.BUCKET, r2Key, chunks, {
		httpMetadata: { contentType: "application/json" },
		customMetadata: { backupId: id, trigger },
	});
	const record = {
		id,
		trigger,
		r2Key,
		filename,
		size: object.size,
		createdByUserId: userId ?? null,
		createdAt: startedAt,
		completedAt: Math.floor(Date.now() / 1000),
	};
	const backupsTable = await env.DB.prepare(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'backups'",
	).first<{ name: string }>();
	if (backupsTable) {
		const statement = createSafetyBackupRecordStatement(record);
		await env.DB.prepare(statement.sql)
			.bind(...statement.params)
			.run();
	}
	return record;
}

/**
 * Upserts the safety backup's row. Restore replaces the whole `backups`
 * table, so this runs again at its end to keep the snapshot listed; the
 * creator is only linked when that user exists in the restored data.
 */
export function createSafetyBackupRecordStatement(record: Omit<SafetyBackup, "content">): RestoreStatement {
	return {
		sql: "INSERT OR REPLACE INTO backups (id, status, `trigger`, r2_key, filename, size, error, created_by_user_id, created_at, started_at, completed_at) VALUES (?, 'completed', ?, ?, ?, ?, NULL, (SELECT id FROM users WHERE id = ?), ?, ?, ?)",
		params: [
			record.id,
			record.trigger,
			record.r2Key,
			record.filename,
			record.size,
			record.createdByUserId,
			record.createdAt,
			record.createdAt,
			record.completedAt,
		],
	};
}
