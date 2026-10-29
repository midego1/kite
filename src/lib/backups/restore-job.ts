import { newId } from "@/lib/ids";
import { createLogger } from "@/lib/logger.mjs";
import { getMigrationStatus } from "@/lib/migrations/service";
import { bucketBackupSource } from "./backup-reader";
import { prepareDatabaseRestore } from "./export";
import { executeDatabaseRestore, RESTORE_START, resolveRestoreCursor } from "./restore-engine";
import type { RestoreJob, RestoreJobMessage } from "./restore-job-types";
import { readRestoreJob, RestoreLeaseLostError, writeRestoreJob } from "./restore-job-store";
import {
	interruptedRestorePatch,
	isActiveRestore,
	RESTORE_CHUNK_MS,
	RESTORE_UPLOAD_MAX_AGE_MS,
	restoreJobMessage,
	restoreLeaseMs,
	restoreMaintenanceAction,
	versionedRestorePatch,
} from "./restore-job-utils";
import type { PreparedRestore, RestoreBatchLimits, RestorePlan, RestorePosition } from "./restore-types";
import { RestoreBatchWriter } from "./restore-writer";
import { createKeptBackupRecordStatement, createSafetyBackup } from "./safety";
import { BACKUP_UPLOAD_PREFIX } from "./utils";

const logger = createLogger("backup-restore");

type RestoreJobOptions = {
	/** Wall-clock time to write before handing over to the next message (RESTORE_CHUNK_MS). */
	chunkMs?: number;
	limits?: RestoreBatchLimits;
};

type RestoreRun = {
	env: CloudflareEnv;
	job: RestoreJob;
	etag: string;
	deadline: number;
	options: RestoreJobOptions;
	/** The writer of the chunk being written, which knows whether a batch was committed. */
	writer?: RestoreBatchWriter;
};

function describe(error: unknown): string {
	return error instanceof Error ? error.message : "Database error";
}

/** Saves the job with `patch`, renewing the lease for the step it moves to. Throws when the lease was lost. */
async function save(run: RestoreRun, patch: Partial<RestoreJob>): Promise<void> {
	const next = { ...run.job, ...patch, updatedAt: new Date().toISOString() };
	if (next.lease && !("lease" in patch)) next.lease = { ...next.lease, until: Date.now() + restoreLeaseMs(next) };
	run.etag = await writeRestoreJob(run.env.BUCKET, next, run.etag);
	run.job = next;
}

/** Ends the job: releases the lease and removes an uploaded file, which is not needed any more. */
async function finish(run: RestoreRun, patch: Partial<RestoreJob>): Promise<void> {
	await save(run, { ...patch, lease: null, finishedAt: new Date().toISOString() });
	if (run.job.source.upload) await run.env.BUCKET.delete(run.job.source.key).catch(() => undefined);
	logger.info("backup.restore_finished", { restoreId: run.job.id, status: run.job.status });
}

/** Releases the lease and queues the next step. */
async function handOver(run: RestoreRun): Promise<void> {
	const seq = run.job.seq + 1;
	await save(run, { seq, lease: null });
	await run.env.OUTBOUND_QUEUE.send(restoreJobMessage(run.job.id, seq));
}

function strip({ source: _source, ...plan }: PreparedRestore): RestorePlan {
	return plan;
}

/**
 * The applied migrations, as a fingerprint: they only ever grow, so the count and the latest name tell. A plan is
 * made against one schema and is not continued on another.
 */
async function schemaFingerprint(db: D1Database): Promise<string> {
	const row = await db
		.prepare("SELECT count(*) AS count, max(name) AS last FROM d1_migrations")
		.first<{ count: number; last: string | null }>()
		.catch(() => null);
	return row ? `${row.count}:${row.last ?? ""}` : "";
}

async function validate(run: RestoreRun): Promise<void> {
	try {
		const status = await getMigrationStatus(run.env.DB);
		if (status.pending.length || status.unknown.length)
			throw new Error("Apply pending database migrations in the admin overview before restoring a backup.");
		const schema = await schemaFingerprint(run.env.DB);
		const prepared = await prepareDatabaseRestore(
			run.env.DB,
			await bucketBackupSource(run.env.BUCKET, run.job.source.key),
		);
		const plan = { plan: strip(prepared), rowCount: prepared.rowCount, interruptions: 0, schema };
		// A recovery restores the snapshot it carries and takes none of its own: the data now is the broken half.
		if (run.job.recoveryOf)
			await save(run, { ...plan, status: "restoring", cursor: { at: RESTORE_START, pending: null } });
		else await save(run, { ...plan, status: "snapshot" });
	} catch (error) {
		if (error instanceof RestoreLeaseLostError) throw error;
		await finish(run, { status: "failed", error: describe(error) });
	}
}

async function snapshot(run: RestoreRun): Promise<void> {
	let safety: Awaited<ReturnType<typeof createSafetyBackup>>;
	try {
		// The snapshot lists itself in `backups` straight away, so it can be restored from the Backups page.
		safety = await createSafetyBackup(run.env, "pre-restore", run.job.userId);
	} catch (error) {
		await finish(run, { status: "failed", error: `The safety backup could not be saved: ${describe(error)}` });
		return;
	}
	await save(run, {
		status: "restoring",
		safety: { ...safety, startedAt: safety.createdAt },
		cursor: { at: RESTORE_START, pending: null },
		interruptions: 0,
	});
}

/** Writes from the job's cursor until done or the deadline; null when done, the next position otherwise. */
async function writeChunk(run: RestoreRun, plan: RestorePlan, key: string): Promise<RestorePosition | null> {
	const { env } = run;
	const from = await resolveRestoreCursor(env.DB, run.job.cursor ?? { at: RESTORE_START, pending: null });
	const writer: RestoreBatchWriter = new RestoreBatchWriter(env.DB, run.options.limits, (to, probe) =>
		// The checkpoint goes first: if this invocation dies during the batch, the next one can tell whether it landed.
		save(run, { cursor: { at: writer.committed ?? from, pending: to ? { to, probe } : null }, changed: true }),
	);
	run.writer = writer;
	const keep = [run.job.safety!, ...run.job.kept].map(createKeptBackupRecordStatement);
	const source = await bucketBackupSource(env.BUCKET, key);
	return executeDatabaseRestore(env.DB, { ...plan, source }, { writer, keep, from, deadline: run.deadline });
}

/** Ends a recovery that failed: the database still needs the snapshot it was restoring. */
function failRecovery(run: RestoreRun, error: unknown): Promise<void> {
	logger.error("backup.restore_recovery_failed", { restoreId: run.job.id, error });
	return finish(run, { status: "failed", needsRecovery: true, error: describe(error) });
}

/** Moves a restore whose schema changed under it on: a fresh start before it wrote anything, a rollback after. */
async function schemaChanged(run: RestoreRun): Promise<void> {
	logger.warn("backup.restore_schema_changed", { restoreId: run.job.id });
	if (!run.job.changed || run.job.recoveryOf)
		await save(run, { status: "validating", plan: null, cursor: null, schema: null });
	else
		await save(run, {
			status: "rolling_back",
			error: "Database updates were applied while the restore ran, so it was rolled back",
			cursor: null,
			rollbackPlan: null,
			interruptions: 0,
		});
}

async function restore(run: RestoreRun): Promise<void> {
	if ((await schemaFingerprint(run.env.DB)) !== run.job.schema) return schemaChanged(run);
	try {
		const next = await writeChunk(run, run.job.plan!, run.job.source.key);
		if (next) await save(run, { cursor: { at: next, pending: null } });
		else await finish(run, { status: "completed", cursor: null, needsRecovery: false });
	} catch (error) {
		if (error instanceof RestoreLeaseLostError) throw error;
		if (run.job.recoveryOf) return failRecovery(run, error);
		// `changed` is saved before the first batch is sent. Until then nothing was written; after, even a batch
		// that reported an error may have been committed with its answer lost, so only the rollback is safe.
		if (!run.job.changed) {
			await finish(run, { status: "failed", error: describe(error) });
			return;
		}
		logger.warn("backup.restore_rolling_back", { restoreId: run.job.id, error });
		await save(run, { status: "rolling_back", error: describe(error), cursor: null, interruptions: 0 });
	}
}

async function rollBack(run: RestoreRun): Promise<void> {
	const safety = run.job.safety!;
	try {
		const schema = await schemaFingerprint(run.env.DB);
		if (!run.job.rollbackPlan || schema !== run.job.schema) {
			// The restore's own preserved set: the half-restored database may have gained or lost storage rows.
			const preserved = run.job.plan?.preserved;
			const prepared = await prepareDatabaseRestore(
				run.env.DB,
				await bucketBackupSource(run.env.BUCKET, safety.r2Key),
				{ preserved: Array.isArray(preserved) ? preserved : [] },
			);
			await save(run, { rollbackPlan: strip(prepared), schema, cursor: { at: RESTORE_START, pending: null } });
			return;
		}
		const next = await writeChunk(run, run.job.rollbackPlan, safety.r2Key);
		if (next) await save(run, { cursor: { at: next, pending: null } });
		else await finish(run, { status: "rolled_back", cursor: null });
	} catch (error) {
		if (error instanceof RestoreLeaseLostError) throw error;
		logger.error("backup.restore_rollback_failed", { restoreId: run.job.id, error });
		await finish(run, {
			status: "failed",
			needsRecovery: true,
			error: `${run.job.error ?? "The restore failed"}, and the automatic rollback also failed: ${describe(error)}`,
		});
	}
}

const STEPS: Partial<Record<RestoreJob["status"], (run: RestoreRun) => Promise<void>>> = {
	validating: validate,
	snapshot,
	restoring: restore,
	rolling_back: rollBack,
};

/** Takes the lease for the message's step; null when the message is stale or another invocation holds the job. */
async function claim(env: CloudflareEnv, message: RestoreJobMessage, options: RestoreJobOptions) {
	const stored = await readRestoreJob(env.BUCKET);
	if (!stored || stored.job.id !== message.restoreId || stored.job.seq !== message.seq) return null;
	const { job } = stored;
	const now = Date.now();
	if (!isActiveRestore(job) || (job.lease && job.lease.until > now)) return null;
	const run: RestoreRun = {
		env,
		job,
		etag: stored.etag,
		deadline: now + (options.chunkMs ?? RESTORE_CHUNK_MS),
		options,
	};
	// A lease left behind means the invocation holding it died.
	const interruptions = job.lease ? job.interruptions + 1 : job.interruptions;
	await save(run, { lease: { id: newId("lse"), until: now + restoreLeaseMs(job) }, interruptions });
	if (job.lease) logger.warn("backup.restore_interrupted", { restoreId: job.id, status: job.status, interruptions });
	return run;
}

/**
 * The queue consumer for `backup.restore`: claims the job, runs its steps until it ends or the chunk's time is
 * up, then hands over to a new message. Every step saves its progress first, so an invocation that dies is picked
 * up by the redelivered message or the cron (runRestoreMaintenance).
 */
export async function processRestoreMessage(
	env: CloudflareEnv,
	message: RestoreJobMessage,
	options: RestoreJobOptions = {},
): Promise<void> {
	try {
		const run = await claim(env, message, options);
		if (!run) return;
		const versioned = versionedRestorePatch(run.job);
		const interrupted = versioned ? null : interruptedRestorePatch(run.job);
		if (versioned) {
			logger.warn("backup.restore_version_changed", { restoreId: run.job.id, from: run.job.version ?? null });
			await save(run, versioned);
		} else if (interrupted) {
			if (interrupted.status === "failed") await finish(run, interrupted);
			else await save(run, interrupted);
		}
		// At least one step per message, so a job always moves on, however short the chunk.
		while (isActiveRestore(run.job)) {
			await STEPS[run.job.status]!(run);
			if (isActiveRestore(run.job) && Date.now() >= run.deadline) {
				await handOver(run);
				return;
			}
		}
	} catch (error) {
		if (error instanceof RestoreLeaseLostError) return;
		throw error;
	}
}

/** Gives up a job that stopped making progress, so its safety backup can be restored from the admin overview. */
async function abandon(env: CloudflareEnv, job: RestoreJob, etag: string): Promise<void> {
	const run: RestoreRun = { env, job, etag, deadline: 0, options: {} };
	await finish(run, {
		status: "failed",
		needsRecovery: job.changed || job.needsRecovery,
		error: `${job.error ? `${job.error}; ` : ""}The restore stopped making progress`,
	});
}

/** Removes uploaded backup files a restore left behind, such as one whose request was cut off. */
async function sweepUploads(env: CloudflareEnv, keepKey: string | null, now: number): Promise<number> {
	let removed = 0;
	let cursor: string | undefined;
	do {
		const page = await env.BUCKET.list({ prefix: `${BACKUP_UPLOAD_PREFIX}/`, cursor });
		const stale = page.objects
			.filter((object) => object.key !== keepKey && now - object.uploaded.getTime() > RESTORE_UPLOAD_MAX_AGE_MS)
			.map((object) => object.key);
		if (stale.length) await env.BUCKET.delete(stale);
		removed += stale.length;
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return removed;
}

/** The five-minute cron: revives a stalled restore, gives up an abandoned one, and sweeps old uploads. */
export async function runRestoreMaintenance(env: CloudflareEnv, now = new Date()): Promise<void> {
	const stored = await readRestoreJob(env.BUCKET);
	const job = stored?.job ?? null;
	const action = job ? restoreMaintenanceAction(job, now.getTime()) : "none";
	try {
		if (stored && action === "abandon") await abandon(env, stored.job, stored.etag);
		if (stored && action === "resend") {
			logger.warn("backup.restore_resumed", { restoreId: stored.job.id, seq: stored.job.seq });
			await env.OUTBOUND_QUEUE.send(restoreJobMessage(stored.job.id, stored.job.seq));
		}
	} catch (error) {
		if (!(error instanceof RestoreLeaseLostError)) throw error;
	}
	const removed = await sweepUploads(env, job && isActiveRestore(job) ? job.source.key : null, now.getTime());
	if (removed) logger.info("backup.restore_uploads_swept", { removed });
}
