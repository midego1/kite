import type {
	AttachmentStorageBatchResult,
	AttachmentStorageBudget,
	AttachmentStorageCounters,
	AttachmentStorageDirection,
	AttachmentStorageJob,
	AttachmentStorageJobMessage,
	AttachmentStorageJobView,
} from "./attachment-storage-jobs-types";

/**
 * The admin attachment storage job (`docs/specs/attachments-once.md` §5.5), pure parts: the queue message, the job
 * state's lease and phases, and the per-batch budget. The rows stay the source of truth; the stored job only says
 * which phase runs, where its keyset cursor is and what it has counted, so a killed batch is simply run again.
 */

const ATTACHMENT_STORAGE_JOB_KIND = "attachments.storage";

/**
 * How long a delivery holds the job for one batch; a batch stops starting items after `BATCH_BUDGET_MS`.
 * @public Exercised by the unit tests.
 */
export const LEASE_MS = 60_000;
/** Wall-clock time a batch may spend before it queues the next one (the mailbox purge's 20 s). */
export const BATCH_BUDGET_MS = 20_000;
/**
 * A running job with no claim or batch for this long has stopped (a lost message, a deploy, a killed isolate).
 * @public Exercised by the unit tests.
 */
export const STALL_MS = 2 * 60_000;
/**
 * The cron revives a stopped job only this soon after its last batch, so an old restored backup starts nothing.
 * @public Exercised by the unit tests.
 */
export const REVIVE_WINDOW_MS = 60 * 60_000;
/**
 * Consecutive failed batches before the job is marked failed.
 * @public Exercised by the unit tests.
 */
export const MAX_BATCH_FAILURES = 5;
/** Seconds before a failed batch is tried again. */
export const FAILED_BATCH_RETRY_SECONDS = 60;

/**
 * What one batch may take on. Items run one at a time, so memory peaks at one message or file; the bytes and
 * operations bound the CPU time and the subrequests (R2 and D1 calls) of one Workers invocation.
 */
export const BATCH_BUDGET: AttachmentStorageBudget = { items: 25, bytes: 64 * 1024 * 1024, operations: 300 };
/** Rows a materialize or unshare batch asks for at once. */
export const BATCH_ROWS = 50;

/** Base64 with line breaks stores 3 bytes in about 4.1; the raw message also carries headers and other parts. */
const RAW_OVERHEAD = 1.5;

export function isAttachmentStorageJobMessage(payload: unknown): payload is AttachmentStorageJobMessage {
	if (typeof payload !== "object" || payload === null) return false;
	const message = payload as Partial<AttachmentStorageJobMessage>;
	return (
		message.kind === ATTACHMENT_STORAGE_JOB_KIND &&
		typeof message.jobId === "string" &&
		Number.isInteger(message.batch) &&
		(message.batch ?? -1) >= 0
	);
}

export function jobMessage(job: Pick<AttachmentStorageJob, "id" | "batch">): AttachmentStorageJobMessage {
	return { kind: ATTACHMENT_STORAGE_JOB_KIND, jobId: job.id, batch: job.batch };
}

export function isAttachmentStorageDirection(value: unknown): value is AttachmentStorageDirection {
	return value === "reclaim" || value === "materialize";
}

const STATUSES = new Set(["running", "completed", "failed", "cancelled"]);
const PHASES = new Set(["reclaim", "materialize", "unshare"]);
const COUNTERS = ["done", "converted", "unshared", "unmatched", "failed", "total", "failures", "batch"] as const;

/** The stored job, or null when there is none or it is not one this release understands. */
export function parseJob(value: string | null | undefined): AttachmentStorageJob | null {
	if (!value) return null;
	let job: Partial<AttachmentStorageJob>;
	try {
		job = JSON.parse(value) as Partial<AttachmentStorageJob>;
	} catch {
		return null;
	}
	if (!job || typeof job !== "object" || typeof job.id !== "string") return null;
	if (!isAttachmentStorageDirection(job.direction) || !STATUSES.has(job.status ?? "") || !PHASES.has(job.phase ?? ""))
		return null;
	if (COUNTERS.some((key) => !Number.isFinite(job[key])) || !Number.isFinite(job.heartbeatAt)) return null;
	return job as AttachmentStorageJob;
}

export function isLeased(job: Pick<AttachmentStorageJob, "leaseUntil">, now: number): boolean {
	return (job.leaseUntil ?? 0) > now;
}

/** A running job whose batches still arrive: another one may not start. */
export function isActive(job: AttachmentStorageJob | null, now: number): boolean {
	return !!job && job.status === "running" && (isLeased(job, now) || now - job.heartbeatAt < STALL_MS);
}

/** A running job whose batches stopped arriving. */
export function isStalled(job: AttachmentStorageJob | null, now: number): boolean {
	return !!job && job.status === "running" && !isActive(job, now);
}

/** Whether the 5-minute cron should send a stopped job's batch again. */
export function shouldRevive(job: AttachmentStorageJob | null, now: number): boolean {
	return isStalled(job, now) && now - job!.heartbeatAt < REVIVE_WINDOW_MS;
}

const ZERO: AttachmentStorageCounters = { done: 0, converted: 0, unshared: 0, unmatched: 0, failed: 0 };

export function newJob(input: {
	id: string;
	direction: AttachmentStorageDirection;
	startedBy: string | null;
	total: number;
	now: number;
	testCrashAfter?: number;
}): AttachmentStorageJob {
	return {
		id: input.id,
		direction: input.direction,
		status: "running",
		phase: input.direction === "reclaim" ? "reclaim" : "materialize",
		cursor: null,
		batch: 0,
		startedAt: input.now,
		heartbeatAt: input.now,
		startedBy: input.startedBy,
		total: input.total,
		failures: 0,
		lastError: null,
		...ZERO,
		...(input.testCrashAfter ? { testCrashAfter: input.testCrashAfter } : {}),
	};
}

/** Starting a stopped job again: same cursor and counters, no lease, the next batch sent anew. */
export function resumedJob(job: AttachmentStorageJob, now: number): AttachmentStorageJob {
	const { leaseUntil: _lease, stopReason: _reason, ...rest } = job;
	return { ...rest, batch: job.batch + 1, heartbeatAt: now, failures: 0 };
}

/** The job held by one delivery; the crash hook is taken off so a re-run does not die again. */
export function claimedJob(job: AttachmentStorageJob, now: number): AttachmentStorageJob {
	const { testCrashAfter: _crash, ...rest } = job;
	return { ...rest, leaseUntil: now + LEASE_MS, heartbeatAt: now };
}

/** Seconds until a held lease runs out, for a delivery that has to wait for a batch that died holding it. */
export function leaseWaitSeconds(job: Pick<AttachmentStorageJob, "leaseUntil">, now: number): number {
	return Math.max(1, Math.ceil(((job.leaseUntil ?? now) - now) / 1000) + 1);
}

function addCounters(job: AttachmentStorageJob, result: AttachmentStorageCounters): AttachmentStorageCounters {
	return {
		done: job.done + result.done,
		converted: job.converted + result.converted,
		unshared: job.unshared + result.unshared,
		unmatched: job.unmatched + result.unmatched,
		failed: job.failed + result.failed,
	};
}

/**
 * The job after a batch: counters added, the cursor moved, and at the end of a phase the next one (materialize
 * continues with unshare, whose rows `unshareTotal` counts) or completion. The lease is released either way.
 */
export function finishedBatch(
	job: AttachmentStorageJob,
	result: AttachmentStorageBatchResult,
	now: number,
	unshareTotal?: number,
): AttachmentStorageJob {
	const { leaseUntil: _lease, ...rest } = job;
	const next: AttachmentStorageJob = {
		...rest,
		...addCounters(job, result),
		cursor: result.cursor,
		batch: job.batch + 1,
		heartbeatAt: now,
		failures: 0,
		lastError: result.lastError ?? job.lastError,
	};
	if (!result.exhausted) return next;
	if (job.phase === "materialize")
		return { ...next, phase: "unshare", cursor: null, total: next.done + (unshareTotal ?? 0) };
	return { ...next, status: "completed", finishedAt: now };
}

/** The job after a batch that failed as a whole; the next attempt runs the same batch again. */
export function failedBatch(job: AttachmentStorageJob, error: string, now: number): AttachmentStorageJob {
	const { leaseUntil: _lease, ...rest } = job;
	const failures = job.failures + 1;
	const failed = failures >= MAX_BATCH_FAILURES;
	return {
		...rest,
		batch: job.batch + 1,
		heartbeatAt: now,
		failures,
		lastError: error,
		...(failed ? { status: "failed" as const, finishedAt: now } : {}),
	};
}

export function stoppedJob(
	job: AttachmentStorageJob,
	status: "cancelled",
	now: number,
	stopReason?: AttachmentStorageJob["stopReason"],
): AttachmentStorageJob {
	const { leaseUntil: _lease, ...rest } = job;
	return { ...rest, status, finishedAt: now, ...(stopReason ? { stopReason } : {}) };
}

/** What a batch may cost before it starts: always at least one item, so every batch moves the cursor. */
export function takeWithinBudget<T>(
	items: readonly T[],
	cost: (item: T) => { bytes: number; operations: number },
	budget: AttachmentStorageBudget = BATCH_BUDGET,
): T[] {
	const taken: T[] = [];
	let bytes = 0;
	let operations = 0;
	for (const item of items) {
		if (taken.length >= budget.items) break;
		const next = cost(item);
		if (taken.length && (bytes + next.bytes > budget.bytes || operations + next.operations > budget.operations)) break;
		bytes += next.bytes;
		operations += next.operations;
		taken.push(item);
	}
	return taken;
}

/** One message on reclaim: its raw message, each object, a conditional update per row and the clean-up. */
export function reclaimCost(message: { rows: number; bytes: number }): { bytes: number; operations: number } {
	return { bytes: Math.ceil(message.bytes * (1 + RAW_OVERHEAD)), operations: 4 + 3 * message.rows };
}

/** One 'raw' row on materialize: its location, the ranged read, the write and the conditional update. */
export function materializeCost(row: { size: number }): { bytes: number; operations: number } {
	return { bytes: Math.ceil(row.size * (1 + RAW_OVERHEAD)), operations: 5 };
}

/** One shared row on unshare: the read, the copy and the conditional update. */
export function unshareCost(row: { size: number }): { bytes: number; operations: number } {
	return { bytes: row.size * 2, operations: 4 };
}

/** The result of an empty or partly run batch, to add to as items finish. */
export function emptyBatch(cursor: string | null): AttachmentStorageBatchResult {
	return { ...ZERO, cursor, exhausted: false, lastError: null };
}

/**
 * Whether the development-only crash hook may be used: `ATTACHMENT_STORAGE_TEST_HOOKS` opts in (set only for dev and
 * e2e), and never in production, where a bare `node dist/server.mjs` leaves NODE_ENV unset too.
 */
export function areTestHooksEnabled(flag: string | undefined, nodeEnv: string | undefined): boolean {
	return nodeEnv !== "production" && (flag === "1" || flag === "true");
}

const iso = (value: number | undefined) => (value ? new Date(value).toISOString() : null);

export function jobView(job: AttachmentStorageJob, now: number): AttachmentStorageJobView {
	return {
		id: job.id,
		direction: job.direction,
		status: isStalled(job, now) ? "interrupted" : job.status,
		phase: job.phase,
		total: job.total,
		done: job.done,
		converted: job.converted,
		unshared: job.unshared,
		unmatched: job.unmatched,
		failed: job.failed,
		startedAt: iso(job.startedAt)!,
		finishedAt: iso(job.finishedAt),
		lastError: job.lastError,
		stopReason: job.stopReason ?? null,
	};
}
