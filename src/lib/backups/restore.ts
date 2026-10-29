import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { backups } from "@/db/schema";
import { getMigrationStatus } from "@/lib/migrations/service";
import { newId } from "@/lib/ids";
import { writeBackupObject } from "./backup-writer";
import { bucketBackupSource } from "./backup-reader";
import { executeDatabaseRestore, prepareDatabaseRestore } from "./export";
import type { BackupSource, RestoreOutcome, RestoreStatement } from "./restore-types";
import { RestoreBatchWriter } from "./restore-writer";
import { createKeptBackupRecordStatement, createSafetyBackup, createSafetyBackupRecordStatement } from "./safety";
import { BACKUP_UPLOAD_PREFIX } from "./utils";

function describe(error: unknown): string {
	return error instanceof Error ? error.message : "Database error";
}

/**
 * Replaces the database with a backup without ever leaving it half-restored:
 * the file is validated before anything is written, a snapshot of the
 * current data is saved to R2 first, and a restore too large for one D1
 * transaction is rolled back to that snapshot if any batch fails. The backup
 * and the snapshot are both read by range, so neither has to fit in memory.
 */
async function restoreDatabaseBackup(
	env: CloudflareEnv,
	source: BackupSource,
	userId: string | null,
	keepRecords: RestoreStatement[] = [],
): Promise<RestoreOutcome> {
	const status = await getMigrationStatus(env.DB);
	if (status.pending.length || status.unknown.length) {
		throw new Error("Apply pending database migrations in the admin overview before restoring a backup.");
	}
	const prepared = await prepareDatabaseRestore(env.DB, source);

	const safety = await createSafetyBackup(env, "pre-restore", userId);
	const keep = [createSafetyBackupRecordStatement(safety), ...keepRecords];
	const writer = new RestoreBatchWriter(env.DB);
	try {
		await executeDatabaseRestore(env.DB, prepared, writer, keep);
	} catch (error) {
		// D1 runs each batch as a transaction, so a failure in the first one left everything as it was.
		if (!writer.committedBatches) throw new Error(`Restore failed and nothing was changed: ${describe(error)}`);
		try {
			const rollback = await prepareDatabaseRestore(env.DB, await bucketBackupSource(env.BUCKET, safety.r2Key));
			await executeDatabaseRestore(env.DB, rollback, new RestoreBatchWriter(env.DB), keep);
		} catch (rollbackError) {
			throw new Error(
				`Restore failed (${describe(error)}) and the automatic rollback also failed (${describe(rollbackError)}). Restore the backup "${safety.filename}" (R2 key ${safety.r2Key}) to recover the previous data.`,
			);
		}
		throw new Error(
			`Restore failed and the previous data was put back from the "${safety.filename}" backup: ${describe(error)}`,
		);
	}
	return { atomic: writer.committedBatches <= 1, safetyBackupId: safety.id, rowCount: prepared.rowCount };
}

function toSeconds(date: Date | null): number | null {
	return date ? Math.floor(date.getTime() / 1000) : null;
}

/**
 * Restores a completed backup straight from storage, which is how a backup
 * larger than any upload limit comes back. Its own row is written back at the
 * end, so it stays listed even when it is newer than the data it restores.
 * Returns null when there is no such completed backup.
 */
export async function restoreStoredBackup(
	env: CloudflareEnv,
	backupId: string,
	userId: string | null,
): Promise<RestoreOutcome | null> {
	const [backup] = await getDb(env).select().from(backups).where(eq(backups.id, backupId)).limit(1);
	if (!backup?.r2Key || backup.status !== "completed") return null;
	const keep = createKeptBackupRecordStatement({
		...backup,
		r2Key: backup.r2Key,
		createdAt: toSeconds(backup.createdAt)!,
		startedAt: toSeconds(backup.startedAt),
		completedAt: toSeconds(backup.completedAt),
	});
	return restoreDatabaseBackup(env, await bucketBackupSource(env.BUCKET, backup.r2Key), userId, [keep]);
}

/**
 * Restores an uploaded backup file. The upload is streamed to storage first
 * and restored from there by range, so its size is bounded by the request
 * limit rather than by Worker memory; the copy is removed afterwards.
 */
export async function restoreUploadedBackup(
	env: CloudflareEnv,
	body: ReadableStream<Uint8Array>,
	userId: string | null,
): Promise<RestoreOutcome> {
	const key = `${BACKUP_UPLOAD_PREFIX}/${newId("upl")}.json`;
	try {
		const { size } = await writeBackupObject(env.BUCKET, key, readStream(body), {
			httpMetadata: { contentType: "application/json" },
		});
		if (!size) throw new Error("Choose a backup file");
		return await restoreDatabaseBackup(env, await bucketBackupSource(env.BUCKET, key), userId);
	} finally {
		await env.BUCKET.delete(key).catch(() => undefined);
	}
}

async function* readStream(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
	const reader = body.getReader();
	try {
		for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) yield chunk.value;
	} finally {
		reader.releaseLock();
	}
}
