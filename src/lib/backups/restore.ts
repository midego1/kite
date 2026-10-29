import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { backups } from "@/db/schema";
import { getMigrationStatus } from "@/lib/migrations/service";
import { newId } from "@/lib/ids";
import { writeBackupObject } from "./backup-writer";
import type { RestoreJob } from "./restore-job-types";
import { readRestoreJob, RestoreLeaseLostError, writeRestoreJob } from "./restore-job-store";
import { isActiveRestore, RESTORE_JOB_VERSION, restoreJobMessage } from "./restore-job-utils";
import type { KeptBackupRecord } from "./safety-types";
import { BACKUP_UPLOAD_PREFIX } from "./utils";

/** A restore is already running; only one may run at a time. */
export class RestoreBusyError extends Error {
	constructor() {
		super("A restore is already running. Wait for it to finish before starting another.");
	}
}

/** A restore could not be rolled back and its previous data has not been restored yet. */
export class RestoreRecoveryPendingError extends Error {
	constructor() {
		super(
			"A restore could not be rolled back. Restore the previous data from the admin overview before restoring another backup.",
		);
	}
}

/** The upload is larger than this runtime accepts (NODE_BACKUP_UPLOAD_MAX_BYTES on Node). */
export class RestoreUploadTooLargeError extends Error {
	constructor(maxBytes: number) {
		super(
			`The backup file is larger than ${Math.round(maxBytes / 1024 ** 2)} MB. Restore it from the Backups list instead.`,
		);
	}
}

/** The largest backup file the self-hosted server accepts as an upload; larger ones are restored from storage. */
export const NODE_BACKUP_UPLOAD_MAX_BYTES = 1024 ** 3;

type RestoreRequest = {
	source: RestoreJob["source"];
	kept: KeptBackupRecord[];
	userId: string | null;
	/** For a recovery: the snapshot it restores, and the restore it recovers from. */
	recovery?: { safety: KeptBackupRecord; of: NonNullable<RestoreJob["recoveryOf"]> };
};

/** Refuses a new restore while one runs, and anything but a recovery while one is needed. */
function assertCanStart(current: RestoreJob | undefined, recovery: boolean): void {
	if (current && isActiveRestore(current)) throw new RestoreBusyError();
	if (current?.needsRecovery && !recovery) throw new RestoreRecoveryPendingError();
}

async function assertMigrated(env: CloudflareEnv): Promise<void> {
	const status = await getMigrationStatus(env.DB);
	if (status.pending.length || status.unknown.length)
		throw new Error("Apply pending database migrations in the admin overview before restoring a backup.");
}

/**
 * Records a restore job and queues it on the outbound queue, so the restore does not depend on the request
 * staying alive (processRestoreMessage in restore-job.ts runs it). Refuses while another restore is running.
 */
async function startRestore(env: CloudflareEnv, request: RestoreRequest, id = newId("rst")): Promise<RestoreJob> {
	const current = await readRestoreJob(env.BUCKET);
	assertCanStart(current?.job, !!request.recovery);
	await assertMigrated(env);
	const now = new Date().toISOString();
	const job: RestoreJob = {
		version: RESTORE_JOB_VERSION,
		id,
		status: "validating",
		seq: 0,
		lease: null,
		userId: request.userId,
		createdAt: now,
		updatedAt: now,
		finishedAt: null,
		source: request.source,
		kept: request.kept,
		plan: null,
		safety: request.recovery?.safety ?? null,
		rollbackPlan: null,
		cursor: null,
		interruptions: 0,
		rowCount: 0,
		error: null,
		changed: false,
		// A recovery leaves the database needing one until it completes.
		needsRecovery: !!request.recovery,
		recoveryOf: request.recovery?.of ?? null,
		schema: null,
	};
	// Conditional on the version read above (or on there being none), so two restores started together cannot
	// both win.
	try {
		await writeRestoreJob(env.BUCKET, job, current?.etag ?? null);
	} catch (error) {
		throw error instanceof RestoreLeaseLostError ? new RestoreBusyError() : error;
	}
	await env.OUTBOUND_QUEUE.send(restoreJobMessage(job.id, job.seq));
	return job;
}

function toSeconds(date: Date | null): number | null {
	return date ? Math.floor(date.getTime() / 1000) : null;
}

/**
 * Restores a completed backup straight from storage, which is how a backup
 * larger than any upload limit comes back. Its own row is written back right
 * after the `backups` table, so it stays listed even when it is newer than the
 * data it restores. Returns null when there is no such completed backup.
 */
export async function startStoredRestore(
	env: CloudflareEnv,
	backupId: string,
	userId: string | null,
): Promise<RestoreJob | null> {
	const [backup] = await getDb(env)
		.select({
			id: backups.id,
			status: backups.status,
			trigger: backups.trigger,
			r2Key: backups.r2Key,
			filename: backups.filename,
			size: backups.size,
			createdByUserId: backups.createdByUserId,
			createdAt: backups.createdAt,
			startedAt: backups.startedAt,
			completedAt: backups.completedAt,
		})
		.from(backups)
		.where(eq(backups.id, backupId))
		.limit(1);
	if (!backup?.r2Key || backup.status !== "completed") return null;
	const kept: KeptBackupRecord = {
		...backup,
		r2Key: backup.r2Key,
		createdAt: toSeconds(backup.createdAt)!,
		startedAt: toSeconds(backup.startedAt),
		completedAt: toSeconds(backup.completedAt),
	};
	return startRestore(env, {
		source: { key: backup.r2Key, upload: false, filename: backup.filename },
		kept: [kept],
		userId,
	});
}

/**
 * Restores the safety backup of a restore that could not be rolled back, from the state object rather than the
 * `backups` table, which may not list it. Null when the latest restore needs no recovery.
 */
export async function startSafetyRecovery(env: CloudflareEnv, userId: string | null): Promise<RestoreJob | null> {
	const current = (await readRestoreJob(env.BUCKET))?.job;
	const safety = current?.needsRecovery ? current.safety : null;
	if (!current || !safety) return null;
	return startRestore(env, {
		source: { key: safety.r2Key, upload: false, filename: safety.filename },
		kept: [],
		userId,
		// A failed recovery hands the original restore on, so the next attempt still names it.
		recovery: { safety, of: current.recoveryOf ?? { id: current.id, error: current.error } },
	});
}

/**
 * Restores an uploaded backup file. The upload is streamed to storage first
 * and restored from there by range, so its size is bounded by the request
 * limit rather than by Worker memory; the job removes the copy when it ends,
 * and the cron removes one a cut-off request left behind.
 */
export async function startUploadedRestore(
	env: CloudflareEnv,
	body: ReadableStream<Uint8Array>,
	userId: string | null,
	maxBytes = Number.POSITIVE_INFINITY,
): Promise<RestoreJob> {
	assertCanStart((await readRestoreJob(env.BUCKET))?.job, false);
	await assertMigrated(env);
	const id = newId("rst");
	const key = `${BACKUP_UPLOAD_PREFIX}/${id}.json`;
	try {
		const { size } = await writeBackupObject(env.BUCKET, key, readStream(body, maxBytes), {
			httpMetadata: { contentType: "application/json" },
		});
		if (!size) throw new Error("Choose a backup file");
		return await startRestore(env, { source: { key, upload: true, filename: null }, kept: [], userId }, id);
	} catch (error) {
		await env.BUCKET.delete(key).catch(() => undefined);
		throw error;
	}
}

async function* readStream(body: ReadableStream<Uint8Array>, maxBytes: number): AsyncGenerator<Uint8Array> {
	const reader = body.getReader();
	let bytes = 0;
	try {
		for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
			bytes += chunk.value.byteLength;
			if (bytes > maxBytes) throw new RestoreUploadTooLargeError(maxBytes);
			yield chunk.value;
		}
	} finally {
		reader.releaseLock();
	}
}
