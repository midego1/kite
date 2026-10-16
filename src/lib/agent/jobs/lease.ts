import { and, eq, lt, lte, or, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { agentJobs } from "@/db/schema";
import { agentProviderErrorMessage } from "../errors";
import { agentJobQueueMessage } from "../queue-utils";

type AgentJobRow = typeof agentJobs.$inferSelect;

const LEASE_MS = 10 * 60_000;
const MAX_ATTEMPTS = 3;
const LEASE_EXHAUSTED_REASON = "The last attempt stopped before it finished, and no attempts are left.";

/**
 * Takes the job's 10-minute lease and returns the row as it was before the claim.
 * Returns "mailbox_busy" only while this job is still claimable but another job in its mailbox
 * is running, or null for other unsuccessful claims. Draft and triage jobs never overlap.
 */
export async function claimAgentJob(db: AppDatabase, jobId: string): Promise<AgentJobRow | "mailbox_busy" | null> {
	const [job] = await db.select().from(agentJobs).where(eq(agentJobs.id, jobId)).limit(1);
	if (!job || job.status === "completed" || job.status === "skipped" || job.status === "failed") return null;
	const now = new Date();
	if (job.nextAttemptAt > now || (job.status === "running" && job.leaseUntil && job.leaseUntil > now)) return null;
	// A run killed by the CPU or memory limit never reaches failAgentJob, so its row stays running.
	// Without this check every expired lease would grant another attempt, forever.
	if (job.status === "running" && job.attempts >= MAX_ATTEMPTS) {
		await db
			.update(agentJobs)
			.set({ status: "failed", leaseUntil: null, reason: LEASE_EXHAUSTED_REASON })
			.where(
				and(
					eq(agentJobs.id, jobId),
					eq(agentJobs.status, "running"),
					eq(agentJobs.attempts, job.attempts),
					lt(agentJobs.leaseUntil, now),
				),
			);
		return null;
	}
	const eligible = and(
		eq(agentJobs.id, jobId),
		eq(agentJobs.attempts, job.attempts),
		lte(agentJobs.nextAttemptAt, now),
		or(eq(agentJobs.status, "pending"), and(eq(agentJobs.status, "running"), lt(agentJobs.leaseUntil, now))),
	);
	const mailboxBusy = sql`EXISTS (SELECT 1 FROM agent_jobs active WHERE active.mailbox_id = ${job.mailboxId} AND active.id <> ${jobId} AND active.status = 'running' AND active.lease_until > ${Math.floor(now.getTime() / 1000)})`;
	const claimed = await db
		.update(agentJobs)
		.set({ status: "running", attempts: job.attempts + 1, leaseUntil: new Date(Date.now() + LEASE_MS) })
		.where(and(eligible, sql`NOT ${mailboxBusy}`))
		.returning({ id: agentJobs.id });
	if (claimed.length) return job;
	// Recheck eligibility after losing the update: another consumer may have claimed this job.
	const [blocked] = await db.select({ id: agentJobs.id }).from(agentJobs).where(and(eligible, mailboxBusy)).limit(1);
	return blocked ? "mailbox_busy" : null;
}

/** Whether the claimed attempt of `job` (the row as it was before the claim) is its last one. */
export function isLastAttempt(job: Pick<AgentJobRow, "attempts">): boolean {
	return job.attempts + 1 >= MAX_ATTEMPTS;
}

export async function skipAgentJob(db: AppDatabase, jobId: string, reason: string) {
	await db.update(agentJobs).set({ status: "skipped", reason, leaseUntil: null }).where(eq(agentJobs.id, jobId));
}

/**
 * Puts a claimed job back with backoff (5 s, then 10 s, at most 60 s), or marks it failed after
 * the third attempt. `job` is the row as it was before the claim. Returns the backoff in ms when
 * the job will run again, or null when it failed for good.
 */
async function failAgentJob(db: AppDatabase, job: AgentJobRow, error: unknown): Promise<number | null> {
	const attempts = job.attempts + 1;
	const backoffMs = Math.min(60_000, 5_000 * 2 ** job.attempts);
	const failed = attempts >= MAX_ATTEMPTS;
	await db
		.update(agentJobs)
		.set({
			status: failed ? "failed" : "pending",
			nextAttemptAt: new Date(Date.now() + backoffMs),
			leaseUntil: null,
			reason: agentProviderErrorMessage(error).slice(0, 300),
		})
		.where(eq(agentJobs.id, job.id));
	return failed ? null : backoffMs;
}

/**
 * Fails the attempt and, when another one is due, queues it for after the backoff so retries do
 * not wait for the maintenance cron. A delivery that arrives early is refused by the claim.
 */
export async function failAndRequeueAgentJob(env: CloudflareEnv, db: AppDatabase, job: AgentJobRow, error: unknown) {
	const backoffMs = await failAgentJob(db, job, error);
	if (backoffMs === null) return;
	await env.AGENT_QUEUE?.send(agentJobQueueMessage(job.kind, job.id), {
		delaySeconds: Math.ceil(backoffMs / 1000) + 1,
	});
}
