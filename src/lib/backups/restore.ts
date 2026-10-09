import { getMigrationStatus } from "@/lib/migrations/service";
import { executeDatabaseRestore, prepareDatabaseRestore } from "./export";
import type { RestoreOutcome } from "./restore-types";
import { appendToRestorePlan } from "./restore-utils";
import { createSafetyBackup, createSafetyBackupRecordStatement } from "./safety";

async function readSafetyBackup(env: CloudflareEnv, r2Key: string): Promise<ArrayBuffer> {
	const object = await env.BUCKET.get(r2Key);
	if (!object) throw new Error("the safety backup could not be read back from R2");
	return object.arrayBuffer();
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : "Database error";
}

/**
 * Replaces the database with a backup without ever leaving it half-restored:
 * the file is validated before anything is written, a snapshot of the
 * current data is saved to R2 first, and a restore too large for one D1
 * transaction is rolled back to that snapshot if any batch fails.
 */
export async function restoreDatabaseBackup(
	env: CloudflareEnv,
	content: ArrayBuffer,
	userId: string | null,
): Promise<RestoreOutcome> {
	const status = await getMigrationStatus(env.DB);
	if (status.pending.length || status.unknown.length) {
		throw new Error("Apply pending database migrations in the admin overview before restoring a backup.");
	}
	const prepared = await prepareDatabaseRestore(env.DB, content);

	const safety = await createSafetyBackup(env, "pre-restore", userId);
	const keepSafetyRecord = createSafetyBackupRecordStatement(safety);
	const plan = appendToRestorePlan(prepared, [keepSafetyRecord]);
	try {
		await executeDatabaseRestore(env.DB, plan);
	} catch (error) {
		if (plan.atomic) throw new Error(`Restore failed and nothing was changed: ${describe(error)}`);
		try {
			const rollback = appendToRestorePlan(
				await prepareDatabaseRestore(env.DB, await readSafetyBackup(env, safety.r2Key)),
				[keepSafetyRecord],
			);
			await executeDatabaseRestore(env.DB, rollback);
		} catch (rollbackError) {
			throw new Error(
				`Restore failed (${describe(error)}) and the automatic rollback also failed (${describe(rollbackError)}). Restore the backup "${safety.filename}" (R2 key ${safety.r2Key}) to recover the previous data.`,
			);
		}
		throw new Error(
			`Restore failed and the previous data was put back from the "${safety.filename}" backup: ${describe(error)}`,
		);
	}
	return { atomic: plan.atomic, safetyBackupId: safety.id, rowCount: plan.rowCount };
}
