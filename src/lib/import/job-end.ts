import { and, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { importJobs } from "@/db/schema/import-jobs";
import { MailServerRefusedError } from "@/lib/net/errors";
import { closeOpenFolders } from "./account-jobs";
import { nextLease, underLease, type ImportJobRow, type LeaseHold } from "./job-run";
import { noteAfterError } from "./size-guard-utils";

/**
 * Taking, handing on and ending the job a run holds (see `LeaseHold` for the fencing every write here relies on).
 */

const MAX_ATTEMPTS = 5;
export const ACTIVE_STATUSES = ["pending", "running"] as const;

export async function enqueueImportJob(env: CloudflareEnv, jobId: string, delaySeconds?: number): Promise<boolean> {
	const queue = env.AGENT_QUEUE;
	if (!queue) return false;
	await queue.send({ kind: "import.imap", jobId }, delaySeconds ? { delaySeconds } : undefined);
	return true;
}

/** Marks the unfinished folders of this job as skipped when it ended cancelled or failed while the run was going. */
export async function closeFoldersOfEndedJob(env: CloudflareEnv, jobId: string): Promise<void> {
	const [row] = await getDb(env)
		.select({ status: importJobs.status })
		.from(importJobs)
		.where(eq(importJobs.id, jobId))
		.limit(1)
		.catch(() => []);
	if (row?.status === "cancelled" || row?.status === "failed") await closeOpenFolders(env, [jobId]);
}

/**
 * Ends this run's hold on a job that was paused while it ran (a user pause keeps the lease), so Resume can start it
 * at once; when it was resumed meanwhile and is waiting, it is queued, since the queued run met the lease and left.
 * Only the lease this run last wrote is cleared: a job another run has claimed since keeps its own.
 */
export async function releaseImportLease(env: CloudflareEnv, hold: LeaseHold): Promise<void> {
	const row = await underLease(hold, async (held) => {
		const [released] = await getDb(env)
			.update(importJobs)
			.set({ leaseUntil: null })
			.where(
				and(
					eq(importJobs.id, hold.jobId),
					eq(importJobs.leaseUntil, held),
					inArray(importJobs.status, ["pending", "paused"]),
				),
			)
			.returning({ status: importJobs.status });
		hold.ended = true;
		return released;
	});
	if (row?.status === "pending") await enqueueImportJob(env, hold.jobId);
}

/**
 * Takes the job's lease and returns it: the value this run holds the job by, always later than the one before.
 * Jobs that share a source account run one at a time, because providers such as iCloud and Gmail limit
 * concurrent IMAP connections per account.
 */
export async function claimJob(
	env: CloudflareEnv,
	job: ImportJobRow,
	now: Date,
	leaseMs: number,
): Promise<Date | null> {
	const nowSeconds = Math.floor(now.getTime() / 1000);
	const lease = nextLease(job.leaseUntil, leaseMs);
	const claimed = await getDb(env)
		.update(importJobs)
		.set({
			status: "running",
			leaseUntil: lease,
			startedAt: job.startedAt ?? now,
			updatedAt: now,
		})
		.where(
			and(
				eq(importJobs.id, job.id),
				inArray(importJobs.status, [...ACTIVE_STATUSES]),
				or(isNull(importJobs.leaseUntil), lt(importJobs.leaseUntil, now)),
				sql`NOT EXISTS (SELECT 1 FROM import_jobs other WHERE other.id <> ${job.id} AND other.host = ${job.host} AND other.username = ${job.username} AND other.status = 'running' AND other.lease_until > ${nowSeconds})`,
			),
		)
		.returning({ id: importJobs.id });
	return claimed.length > 0 ? lease : null;
}

/** A failed run: permanent errors end the job, others are retried with a growing delay. */
export async function recordRunError(
	env: CloudflareEnv,
	job: ImportJobRow,
	hold: LeaseHold,
	error: unknown,
): Promise<void> {
	const message = error instanceof Error ? error.message : "IMAP import failed";
	const attempts = job.attempts + 1;
	if (isPermanentImportError(error, message) || attempts >= MAX_ATTEMPTS) {
		await finishJob(env, job, hold, "failed", message);
		return;
	}
	const retry = await underLease(hold, async (held) => {
		const rows = await getDb(env)
			.update(importJobs)
			.set({
				attempts,
				// A transient error is retried; the confirmation to go on above 90% must survive it.
				lastError: noteAfterError(job.lastError, message),
				leaseUntil: null,
				total: job.total,
				updatedAt: new Date(),
			})
			.where(and(eq(importJobs.id, job.id), eq(importJobs.status, "running"), eq(importJobs.leaseUntil, held)))
			.returning({ id: importJobs.id });
		hold.ended = true;
		return rows.length > 0;
	});
	if (retry) await enqueueImportJob(env, job.id, 30 * attempts);
}

/** Refused connections (no TLS, a private host), authentication and missing-folder errors will not fix themselves. */
function isPermanentImportError(error: unknown, message: string): boolean {
	return (
		error instanceof MailServerRefusedError ||
		/AUTHENTICATIONFAILED|LOGIN|sign-in failed|NONEXISTENT|does not exist|not allowed/i.test(message)
	);
}

/** Ends the job this run holds. A run that no longer holds it (cancelled meanwhile, or taken over) changes nothing. */
export async function finishJob(
	env: CloudflareEnv,
	job: ImportJobRow,
	hold: LeaseHold,
	status: "completed" | "failed",
	lastError?: string,
): Promise<void> {
	const db = getDb(env);
	const now = new Date();
	const finished = await underLease(hold, async (held) => {
		const rows = await db
			.update(importJobs)
			.set({
				status,
				password: "",
				leaseUntil: null,
				lastError: lastError ?? null,
				total: job.total,
				updatedAt: now,
				finishedAt: now,
			})
			.where(and(eq(importJobs.id, job.id), eq(importJobs.leaseUntil, held)))
			.returning({ id: importJobs.id });
		hold.ended = true;
		return rows.length > 0;
	});
	if (!finished) return;
	if (status === "failed" && job.scope === "account") await closeOpenFolders(env, [job.id]);
	await startNextJobForAccount(env, job);
}

/** Starts the oldest waiting job that uses the same source account. */
async function startNextJobForAccount(env: CloudflareEnv, job: ImportJobRow): Promise<void> {
	const [next] = await getDb(env)
		.select({ id: importJobs.id })
		.from(importJobs)
		.where(
			and(
				eq(importJobs.host, job.host),
				eq(importJobs.username, job.username),
				ne(importJobs.id, job.id),
				inArray(importJobs.status, [...ACTIVE_STATUSES]),
			),
		)
		.orderBy(importJobs.createdAt)
		.limit(1);
	if (next) await enqueueImportJob(env, next.id);
}
