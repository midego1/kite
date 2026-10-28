import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { importJobs } from "@/db/schema/import-jobs";
import { getDatabaseSize } from "@/lib/db/size";
import { createLogger } from "@/lib/logger.mjs";
import type { ImapFetchedMessage } from "@/lib/imap/types";
import type { ImapSession } from "@/lib/imap/session";
import { moduleHost } from "@/lib/modules/host";
import type { CapabilityCallContext } from "@/lib/modules/module-types";
import type { HostImportMessage, HostImportResult } from "@/lib/modules/host-types";
import { encodeRawMime } from "@/lib/email/module-import-utils";
import { getImportMessageUserId, parseImportDestination } from "./destination";
import { chunk, hostImportMessageFromImap, selectRemainingUids } from "./imap-utils";
import { importPauseNote } from "./size-guard-utils";

const logger = createLogger("import");

export type ImportJobRow = typeof importJobs.$inferSelect;

/** Messages fetched per IMAP round trip. */
const FETCH_CHUNK_SIZE = 25;
/**
 * Work per queue invocation. Each message costs a handful of D1/R2 calls, so this
 * keeps one invocation well inside the Workers subrequest and wall-time limits;
 * the job re-enqueues itself to continue.
 */
export const MESSAGES_PER_RUN = 200;
/**
 * Time after which a run starts no new chunk. One IMAP command may then still take up to ten minutes (the longest
 * `imapLimits` allows), so the budget plus that command stays within the 14 minutes of `IMPORT_RUN_TIMEOUT_MS`.
 */
const RUN_TIME_BUDGET_MS = 4 * 60_000;
/**
 * A run holds its job through a lease that it renews every `HEARTBEAT_MS` while it is alive (`startLeaseHeartbeat`),
 * so the lease only has to outlast a few missed beats, and a worker that died is found within `LEASE_MS`. A single
 * IMAP command may take up to ten minutes; the heartbeat keeps the lease through it.
 */
const LEASE_MS = 3 * 60_000;
const HEARTBEAT_MS = 60_000;
/** The lease and heartbeat intervals of a run; the tests pass shorter ones. */
export type ImportTiming = { leaseMs: number; heartbeatMs: number };
export const DEFAULT_IMPORT_TIMING: ImportTiming = { leaseMs: LEASE_MS, heartbeatMs: HEARTBEAT_MS };
const MAX_STORED_ERRORS = 20;

/**
 * What a run knows about its hold on a job. The exact `lease_until` value it last wrote is its fencing token: every
 * write of the run to the job row is conditioned on it still being the stored value, so a run whose lease ran out and
 * was claimed by another run (which writes a different, later value) can neither save progress, renew, finish nor
 * release the job any more. Pause and Resume keep `lease_until`, so the token survives them; Cancel and a finished
 * job clear it, so a stale run stops.
 */
export type LeaseHold = {
	jobId: string;
	/** The lease value this run last wrote. */
	lease: Date;
	/** A write of this run found the job held by someone else (or ended): the run stops before its next write. */
	lost: boolean;
	/** This run released the lease itself, so a beat must not look for it any more. */
	ended: boolean;
	/** The run's lease writes in order, so a beat never overlaps the write that renews the token. */
	queue: Promise<unknown>;
};

export const newLeaseHold = (jobId: string, lease: Date): LeaseHold => ({
	jobId,
	lease,
	lost: false,
	ended: false,
	queue: Promise.resolve(),
});

/** The lease from now, always at least a second after `previous`, so a new holder's token never equals the old one. */
export function nextLease(previous: Date | null, leaseMs: number): Date {
	const seconds = Math.floor((Date.now() + leaseMs) / 1000);
	const after = previous ? Math.floor(previous.getTime() / 1000) + 1 : 0;
	return new Date(Math.max(seconds, after) * 1000);
}

/** Runs a write of this run's lease after its earlier ones, handing it the token the run holds at that point. */
export function underLease<T>(hold: LeaseHold, write: (held: Date) => Promise<T>): Promise<T> {
	const result = hold.queue.then(() => write(hold.lease));
	hold.queue = result.catch(() => undefined);
	return result;
}

/** One queue invocation of a job: its signed-in session, what it may still do and what it did so far. */
export type ImportRun = {
	env: CloudflareEnv;
	ctx: CapabilityCallContext;
	job: ImportJobRow;
	mailbox: { id: string; userId: string };
	session: ImapSession;
	hold: LeaseHold;
	timing: ImportTiming;
	startedAt: number;
	/** Messages this invocation may still read. */
	budget: number;
	/** The job's totals, saved with every chunk. */
	progress: { processed: number; imported: number; skipped: number };
	total: number | null;
	errors: string[];
	/** Shown on a job that completes with something left out (an account job's failed folders). */
	finishNote: string | null;
};

/** `done`: nothing left; `more`: enqueue the next invocation; `stopped`: cancelled, paused or out of the run. */
export type ImportRunOutcome = "done" | "more" | "stopped";

export const hasRunTime = (run: ImportRun) => Date.now() - run.startedAt < RUN_TIME_BUDGET_MS;

/**
 * Fetches `uids` in chunks, the next one from IMAP while the current one is written to D1/R2, until the time budget
 * runs out. `onChunk` returns false to stop (the job was cancelled or paused). Returns how many UIDs were handled, or
 * null when it stopped.
 */
export async function fetchInChunks(
	run: ImportRun,
	uids: number[],
	options: { gmailLabels?: boolean },
	onChunk: (uids: number[], fetched: Map<string, ImapFetchedMessage>) => Promise<boolean>,
): Promise<number | null> {
	const chunks = chunk(uids, FETCH_CHUNK_SIZE);
	const fetchChunk = (part: number[]) => run.session.fetchMessages(part.map(String), options);
	let handled = 0;
	let nextFetch = chunks.length ? fetchChunk(chunks[0]) : null;
	for (let index = 0; index < chunks.length; index += 1) {
		const fetched = await nextFetch!;
		nextFetch = hasRunTime(run) && index + 1 < chunks.length ? fetchChunk(chunks[index + 1]) : null;
		nextFetch?.catch(() => undefined);
		// Another run holds the job now: nothing of this chunk is written.
		if (run.hold.lost || !(await onChunk(chunks[index], fetched))) {
			await nextFetch?.catch(() => undefined);
			return null;
		}
		handled += chunks[index].length;
		run.budget -= chunks[index].length;
		if (!nextFetch) break;
	}
	return handled;
}

/** Imports one batch into `destination` through the module host, owned as the destination requires. */
export function importBatch(
	run: ImportRun,
	destination: string,
	messages: HostImportMessage[],
): Promise<HostImportResult> {
	return moduleHost.mail.importMessages(run.ctx, {
		userId: getImportMessageUserId(parseImportDestination(destination), run.job.userId, run.mailbox.userId),
		mailboxId: run.mailbox.id,
		destination,
		messages,
	});
}

/** Adds a chunk's outcome to the job's totals; a UID the server did not return counts as skipped. */
export function addChunkResult(run: ImportRun, handled: number, result: HostImportResult & { missing: number }): void {
	run.progress = {
		processed: run.progress.processed + handled,
		imported: run.progress.imported + result.imported,
		skipped: run.progress.skipped + result.skipped + result.failed + result.missing,
	};
	run.errors = [...run.errors, ...result.errors].slice(-MAX_STORED_ERRORS);
}

/**
 * Saves a finished chunk and renews the lease in one statement, conditioned on the run still holding it. The progress
 * is kept also when the job was paused meanwhile (its cursor must not go back; the lease then stays as the pause kept
 * it). False when the job is paused, ended or held by another run (`hold.lost`), or when it pauses itself because the
 * database is full. A job paused and resumed while this run held its lease is pending again: the run takes it back
 * and goes on, since a user pause keeps the lease and no other run could start it meanwhile.
 */
export async function recordChunk(
	run: ImportRun,
	chunk: {
		processed: number;
		imported: number;
		skipped: number;
		cursorUid: number | null;
		total: number | null;
		errors: string[];
	},
): Promise<boolean> {
	const { env, job, hold } = run;
	if (hold.lost) return false;
	const { errors, ...fields } = chunk;
	const running = await underLease(hold, async (held) => {
		const next = nextLease(held, run.timing.leaseMs);
		const paused = sql`${importJobs.status} = 'paused'`;
		const [row] = await getDb(env)
			.update(importJobs)
			.set({
				...fields,
				errors: JSON.stringify(errors),
				status: sql`CASE WHEN ${paused} THEN 'paused' ELSE 'running' END`,
				leaseUntil: sql`CASE WHEN ${paused} THEN ${importJobs.leaseUntil} ELSE ${next.getTime() / 1000} END`,
				updatedAt: sql`CASE WHEN ${paused} THEN ${importJobs.updatedAt} ELSE ${Math.floor(Date.now() / 1000)} END`,
			})
			.where(
				and(
					eq(importJobs.id, job.id),
					eq(importJobs.leaseUntil, held),
					inArray(importJobs.status, ["running", "paused", "pending"]),
				),
			)
			.returning({ status: importJobs.status });
		if (!row) hold.lost = true;
		else if (row.status === "running") hold.lease = next;
		return row?.status === "running";
	});
	if (!running) return false;
	// This run still has its batch open; it releases the lease when it stops, so a Resume cannot start a second run.
	return !(await underLease(hold, (held) => pauseIfDatabaseFull(env, job, { keepLease: true, lease: held })));
}

/**
 * Renews the lease of the job this run holds every `timing.heartbeatMs` until `stop()`. A beat is conditioned on the
 * exact lease value the run last wrote, so it extends only the run's own hold: it can neither revive a cancelled,
 * failed or completed job (their lease is cleared) nor extend a lease another run has claimed since, and finding the
 * value changed marks the run as lost. A failed beat is logged and retried at the next one. `stop()` waits for a beat
 * in flight, so none lands after the run released the lease.
 */
export function startLeaseHeartbeat(
	env: CloudflareEnv,
	hold: LeaseHold,
	timing: ImportTiming,
): { stop: () => Promise<void> } {
	let beating: Promise<void> | null = null;
	let stopped = false;
	const beat = () => {
		if (stopped || beating || hold.lost || hold.ended) return;
		beating = underLease(hold, async (held) => {
			if (hold.lost || hold.ended) return;
			const next = nextLease(held, timing.leaseMs);
			const [row] = await getDb(env)
				.update(importJobs)
				.set({ leaseUntil: next })
				.where(
					and(
						eq(importJobs.id, hold.jobId),
						eq(importJobs.leaseUntil, held),
						inArray(importJobs.status, ["running", "pending", "paused"]),
					),
				)
				.returning({ id: importJobs.id });
			if (row) hold.lease = next;
			else {
				hold.lost = true;
				logger.info("import.lease_lost", { jobId: hold.jobId });
			}
		})
			.catch((error) => logger.warn("import.lease_beat_failed", { jobId: hold.jobId, error }))
			.finally(() => {
				beating = null;
			});
	};
	const timer = setInterval(beat, timing.heartbeatMs);
	return {
		stop: async () => {
			stopped = true;
			clearInterval(timer);
			await beating;
		},
	};
}

/**
 * Sets a job paused with its reason. `pause_reason` and `paused_at` arrive with migration 0076; before it the status
 * alone is written, which is all that pausing needs. `keepLease` leaves a running batch's lease in place, so a quick
 * Resume cannot start a second run next to it; the run releases the lease when it stops (`releaseImportLease`).
 */
export async function markPaused(
	env: CloudflareEnv,
	where: ReturnType<typeof and>,
	fields: Partial<typeof importJobs.$inferInsert> & { pauseReason: string },
	options: { keepLease?: boolean } = {},
): Promise<boolean> {
	const db = getDb(env);
	const now = new Date();
	const { pauseReason, ...rest } = fields;
	const base = {
		...rest,
		status: "paused" as const,
		...(options.keepLease ? {} : { leaseUntil: null }),
		updatedAt: now,
	};
	try {
		const rows = await db
			.update(importJobs)
			.set({ ...base, pauseReason, pausedAt: now })
			.where(where)
			.returning({ id: importJobs.id });
		return rows.length > 0;
	} catch {
		const rows = await db.update(importJobs).set(base).where(where).returning({ id: importJobs.id });
		return rows.length > 0;
	}
}

/**
 * Pauses a running job whose database has reached its stop point (90% of the limit, 98% once confirmed). It keeps
 * the saved source password and cursor and waits for Resume.
 */
export async function pauseIfDatabaseFull(
	env: CloudflareEnv,
	job: ImportJobRow,
	options: { keepLease?: boolean; lease?: Date } = {},
): Promise<boolean> {
	const note = importPauseNote(await getDatabaseSize(env), job.lastError);
	if (!note) return false;
	await markPaused(
		env,
		// `lease`: only the run that holds the job pauses it.
		and(
			eq(importJobs.id, job.id),
			eq(importJobs.status, "running"),
			options.lease ? eq(importJobs.leaseUntil, options.lease) : undefined,
		),
		{ lastError: note, pauseReason: "database" },
		options,
	);
	return true;
}

/** One folder job's invocation: the newest UIDs below its cursor, up to the run's budget. */
export async function runFolderJob(run: ImportRun): Promise<ImportRunOutcome> {
	const { job } = run;
	parseImportDestination(job.destination);
	await run.session.examine(job.folder);
	const allUids = await run.session.searchUids();
	run.total = job.maxMessages ? Math.min(job.maxMessages, allUids.length) : allUids.length;
	let remaining = selectRemainingUids(allUids, job.cursorUid);
	if (job.maxMessages) remaining = remaining.slice(0, Math.max(job.maxMessages - job.processed, 0));
	let cursorUid = job.cursorUid;
	const handled = await fetchInChunks(run, remaining.slice(0, run.budget), {}, async (uids, fetched) => {
		const batch: HostImportMessage[] = [];
		for (const uid of uids) {
			const message = fetched.get(String(uid));
			if (message) batch.push(hostImportMessageFromImap(`${job.folder}-${uid}.eml`, message, encodeRawMime));
		}
		const result = await importBatch(run, job.destination, batch);
		addChunkResult(run, uids.length, { ...result, missing: uids.length - batch.length });
		cursorUid = uids[uids.length - 1];
		return recordChunk(run, { ...run.progress, cursorUid, total: run.total, errors: run.errors });
	});
	if (handled === null) return "stopped";
	return handled >= remaining.length ? "done" : "more";
}
