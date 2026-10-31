import { newId } from "@/lib/ids";
import { createLogger } from "@/lib/logger.mjs";
import { missingColumnFromError } from "@/lib/auth/user-lookup-utils";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { runMaterializeBatch, runReclaimBatch, runUnshareBatch, type BatchContext } from "./attachment-storage-batches";
import { getAttachmentStorageCounts, getReclaimCounts, getSharedObjectCounts } from "./attachment-storage-report";
import { isAttachmentRawIndexEnabled, isAttachmentSharingEnabled } from "./attachment-storage-utils";
import {
	BATCH_BUDGET_MS,
	FAILED_BATCH_RETRY_SECONDS,
	areTestHooksEnabled,
	claimedJob,
	failedBatch,
	finishedBatch,
	isActive,
	isLeased,
	isStalled,
	jobMessage,
	jobView,
	leaseWaitSeconds,
	newJob,
	parseJob,
	resumedJob,
	shouldRevive,
	stoppedJob,
} from "./attachment-storage-jobs-utils";
import type {
	AttachmentStorageBatchResult,
	AttachmentStorageDirection,
	AttachmentStorageJob,
	AttachmentStorageJobMessage,
	AttachmentStorageJobView,
} from "./attachment-storage-jobs-types";

const log = createLogger("attachments");

/**
 * The admin attachment storage job (`docs/specs/attachments-once.md` §5.5): reclaim turns 'object' rows of received
 * and imported mail into 'raw' rows and deletes the objects no row names any more; materialize gives every 'raw' row
 * an object of its own again and then a copy to every row sharing another row's object, the safe state before running
 * an older release. One job at a time, in batches on `OUTBOUND_QUEUE`; its state is one JSON value in
 * `app_settings.attachment_storage_job` (migration 0090), swapped with compare-and-set so two deliveries never run
 * the same batch at once.
 */

const SETTINGS_ID = "default";

export type JobEnv = CloudflareEnv;

/** Before migration 0088 (storage columns) or 0090 (job state) nothing here can run. */
export class AttachmentJobsUnavailableError extends Error {
	constructor() {
		super("Apply the pending database update first");
	}
}

/** A batch that the development crash hook killed: it writes nothing, like an isolate that died. */
class SimulatedCrash extends Error {
	constructor() {
		super("Simulated crash (ATTACHMENT_STORAGE_TEST_HOOKS)");
	}
}

type Stored = { raw: string | null; job: AttachmentStorageJob | null };

async function readStored(env: JobEnv): Promise<Stored> {
	try {
		const row = await env.DB.prepare("SELECT attachment_storage_job AS job FROM app_settings WHERE id = ?")
			.bind(SETTINGS_ID)
			.first<{ job: string | null }>();
		const raw = row?.job ?? null;
		return { raw, job: parseJob(raw) };
	} catch (error) {
		if (missingColumnFromError(error)) throw new AttachmentJobsUnavailableError();
		throw error;
	}
}

/** Replaces the stored job only if it is still `expected`; false when another delivery or request changed it. */
async function swapJob(env: JobEnv, expected: string | null, next: AttachmentStorageJob): Promise<boolean> {
	await env.DB.prepare("INSERT INTO app_settings (id, updated_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING")
		.bind(SETTINGS_ID, Math.floor(Date.now() / 1000))
		.run();
	const result = await env.DB.prepare(
		"UPDATE app_settings SET attachment_storage_job = ? WHERE id = ? AND coalesce(attachment_storage_job, '') = ?",
	)
		.bind(JSON.stringify(next), SETTINGS_ID, expected ?? "")
		.run();
	return Number(result.meta?.changes ?? 0) === 1;
}

function send(env: JobEnv, job: AttachmentStorageJob, delaySeconds?: number) {
	return env.OUTBOUND_QUEUE.send(jobMessage(job), delaySeconds ? { delaySeconds } : undefined);
}

/** Whether the storage columns of migration 0088 exist. */
async function storageColumnsReady(env: JobEnv): Promise<boolean> {
	return (await getReclaimCounts(env)) !== null;
}

/** The rows materialize gives an object, counted by their sentinel key like the storage report counts them. */
async function countRawRows(env: JobEnv): Promise<number> {
	return (await getAttachmentStorageCounts(env)).raw.rows;
}

async function initialTotal(env: JobEnv, direction: AttachmentStorageDirection): Promise<number> {
	if (direction === "materialize") return countRawRows(env);
	return (await getReclaimCounts(env))?.pending.rows ?? 0;
}

type JobFailure = { ok: false; status: number; code: string; error: string };
export type JobAnswer = { ok: true; job: AttachmentStorageJobView } | JobFailure;

const failure = (status: number, code: string, error: string): JobFailure => ({ ok: false, status, code, error });

/** The job state for the admin API: the job, and the switches that decide what may run. */
export async function getAttachmentJobStatus(
	env: JobEnv,
): Promise<{ job: AttachmentStorageJobView | null; jobsReady: boolean; switches: Record<string, boolean> }> {
	const switches = {
		rawIndex: isAttachmentRawIndexEnabled(env.ATTACHMENT_RAW_INDEX),
		sharing: isAttachmentSharingEnabled(env.ATTACHMENT_SHARING),
	};
	try {
		const { job } = await readStored(env);
		return { job: job ? jobView(job, Date.now()) : null, jobsReady: await storageColumnsReady(env), switches };
	} catch (error) {
		if (error instanceof AttachmentJobsUnavailableError) return { job: null, jobsReady: false, switches };
		throw error;
	}
}

/**
 * Starts a job, or resumes the stopped job of the same direction from its cursor. Refused while a job is running,
 * before the migrations, and for reclaim while `ATTACHMENT_RAW_INDEX` is off. `testCrashAfter` is honoured only with
 * `ATTACHMENT_STORAGE_TEST_HOOKS` outside production.
 */
export async function startAttachmentJob(
	env: JobEnv,
	actor: { id: string },
	input: { direction: AttachmentStorageDirection; testCrashAfter?: number },
): Promise<JobAnswer> {
	const { direction } = input;
	if (direction === "reclaim" && !isAttachmentRawIndexEnabled(env.ATTACHMENT_RAW_INDEX))
		return failure(409, "RAW_INDEX_OFF", "Reclaim is off while ATTACHMENT_RAW_INDEX is off");
	const ready = await storageColumnsReady(env).catch(() => false);
	if (!ready) return failure(409, "MIGRATION_PENDING", "Apply the pending database update first");
	const stored = await readStored(env);
	const now = Date.now();
	if (isActive(stored.job, now)) return failure(409, "JOB_RUNNING", "An attachment storage job is already running");
	const crashAfter = areTestHooksEnabled(env.ATTACHMENT_STORAGE_TEST_HOOKS, process.env.NODE_ENV)
		? input.testCrashAfter
		: undefined;
	const resume = isStalled(stored.job, now) && stored.job!.direction === direction;
	const base = resume
		? resumedJob(stored.job!, now)
		: newJob({ id: newId("asj"), direction, startedBy: actor.id, total: await initialTotal(env, direction), now });
	const job = crashAfter && crashAfter > 0 ? { ...base, testCrashAfter: Math.floor(crashAfter) } : base;
	if (!(await swapJob(env, stored.raw, job)))
		return failure(409, "JOB_RUNNING", "An attachment storage job is already running");
	await send(env, job);
	await createAuditLog(env, {
		actorUserId: actor.id,
		action: resume ? "attachments.storage_job_resumed" : "attachments.storage_job_started",
		metadata: { jobId: job.id, direction },
	});
	return { ok: true, job: jobView(job, now) };
}

/** Stops the running job after the batch in flight; its rows stay as that batch left them. */
export async function cancelAttachmentJob(env: JobEnv, actor: { id: string }): Promise<JobAnswer> {
	const stored = await readStored(env);
	if (!stored.job || stored.job.status !== "running")
		return failure(409, "NO_JOB", "No attachment storage job is running");
	const now = Date.now();
	const job = stoppedJob(stored.job, "cancelled", now);
	if (!(await swapJob(env, stored.raw, job))) return failure(409, "JOB_CHANGED", "The job changed; try again");
	await createAuditLog(env, {
		actorUserId: actor.id,
		action: "attachments.storage_job_cancelled",
		metadata: { jobId: job.id, direction: job.direction },
	});
	return { ok: true, job: jobView(job, now) };
}

function runPhase(env: JobEnv, job: AttachmentStorageJob, context: BatchContext) {
	if (job.phase === "reclaim") return runReclaimBatch(env, job.cursor, context);
	if (job.phase === "materialize") return runMaterializeBatch(env, job.cursor, context);
	return runUnshareBatch(env, job.cursor, context);
}

function batchContext(job: AttachmentStorageJob, crashAfter: number | undefined): BatchContext {
	let items = 0;
	return {
		deadline: Date.now() + BATCH_BUDGET_MS,
		...(crashAfter
			? {
					afterItem: () => {
						items += 1;
						if (items >= crashAfter) throw new SimulatedCrash();
					},
				}
			: {}),
	};
}

/** The job after `result`; entering unshare counts its rows. */
async function nextAfter(env: JobEnv, job: AttachmentStorageJob, result: AttachmentStorageBatchResult) {
	const entersUnshare = result.exhausted && job.phase === "materialize";
	const unshareTotal = entersUnshare ? (await getSharedObjectCounts(env)).rows : undefined;
	return finishedBatch(job, result, Date.now(), unshareTotal);
}

/** Takes the job for the message's batch; null when the message is stale or another delivery holds it. */
async function claim(env: JobEnv, message: AttachmentStorageJobMessage, stored: Stored) {
	const { job } = stored;
	if (!job || job.id !== message.jobId || job.status !== "running" || job.batch !== message.batch) return null;
	const now = Date.now();
	if (isLeased(job, now)) {
		// The holder is either running this batch (and will send the next one, making this message stale) or died
		// holding it (a killed isolate): come back when the lease runs out.
		await send(env, job, leaseWaitSeconds(job, now));
		return null;
	}
	if (job.phase === "reclaim" && !isAttachmentRawIndexEnabled(env.ATTACHMENT_RAW_INDEX)) {
		await swapJob(env, stored.raw, stoppedJob(job, "cancelled", now, "raw_index_off"));
		log.warn("attachment.storage_job_stopped", { jobId: job.id, reason: "raw_index_off" });
		return null;
	}
	const claimed = claimedJob(job, now);
	return (await swapJob(env, stored.raw, claimed)) ? { claimed, crashAfter: job.testCrashAfter } : null;
}

/**
 * The `attachments.storage` queue message: one batch, then the next message. A batch that fails as a whole is retried
 * after a minute and the job fails after five in a row. It never throws, except for the development crash hook, which
 * leaves the lease held and the cursor where it was, as a killed isolate would.
 */
export async function processAttachmentJob(env: JobEnv, message: AttachmentStorageJobMessage): Promise<void> {
	let stored: Stored;
	try {
		stored = await readStored(env);
	} catch (error) {
		if (error instanceof AttachmentJobsUnavailableError) return;
		throw error;
	}
	const taken = await claim(env, message, stored);
	if (!taken) return;
	const { claimed } = taken;
	const expected = JSON.stringify(claimed);
	let next: AttachmentStorageJob;
	try {
		next = await nextAfter(env, claimed, await runPhase(env, claimed, batchContext(claimed, taken.crashAfter)));
	} catch (error) {
		if (error instanceof SimulatedCrash) throw error;
		log.error("attachment.storage_job_batch_failed", { jobId: claimed.id, phase: claimed.phase, error });
		next = failedBatch(claimed, (error instanceof Error ? error.message : String(error)).slice(0, 300), Date.now());
		// A cancel while the batch ran wins: the swap fails and nothing more is sent.
		if ((await swapJob(env, expected, next)) && next.status === "running")
			await send(env, next, FAILED_BATCH_RETRY_SECONDS);
		return;
	}
	if (!(await swapJob(env, expected, next))) return;
	if (next.status === "running") await send(env, next);
	else log.info("attachment.storage_job_finished", { jobId: next.id, direction: next.direction, status: next.status });
}

/** The 5-minute cron: sends the batch of a job that stopped (a lost message, a deploy) again, within an hour. */
export async function runAttachmentJobMaintenance(env: JobEnv, now = new Date()): Promise<void> {
	let stored: Stored;
	try {
		stored = await readStored(env);
	} catch (error) {
		if (error instanceof AttachmentJobsUnavailableError) return;
		throw error;
	}
	if (!stored.job || !shouldRevive(stored.job, now.getTime())) return;
	const job = resumedJob(stored.job, now.getTime());
	if (await swapJob(env, stored.raw, job)) await send(env, job);
}
