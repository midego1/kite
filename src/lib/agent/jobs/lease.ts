import { and, eq, lt, or, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { agentJobs } from "@/db/schema";
import { agentProviderErrorMessage } from "../errors";

type AgentJobRow = typeof agentJobs.$inferSelect;

const LEASE_MS = 10 * 60_000;
const MAX_ATTEMPTS = 3;

/**
 * Takes the job's 10-minute lease and returns the row as it was before the claim, or null
 * when the job is finished, not due, leased elsewhere, or another job of the same mailbox is
 * running. The mailbox check is kind-agnostic so draft and triage jobs never overlap.
 */
export async function claimAgentJob(db: AppDatabase, jobId: string): Promise<AgentJobRow | null> {
	const [job] = await db.select().from(agentJobs).where(eq(agentJobs.id, jobId)).limit(1);
	if (!job || job.status === "completed" || job.status === "skipped" || job.status === "failed") return null;
	const now = new Date();
	if (job.nextAttemptAt > now || (job.status === "running" && job.leaseUntil && job.leaseUntil > now)) return null;
	const claimed = await db
		.update(agentJobs)
		.set({ status: "running", attempts: job.attempts + 1, leaseUntil: new Date(Date.now() + LEASE_MS) })
		.where(
			and(
				eq(agentJobs.id, jobId),
				or(eq(agentJobs.status, "pending"), and(eq(agentJobs.status, "running"), lt(agentJobs.leaseUntil, now))),
				sql`NOT EXISTS (SELECT 1 FROM agent_jobs active WHERE active.mailbox_id = ${job.mailboxId} AND active.id <> ${jobId} AND active.status = 'running' AND active.lease_until > ${Math.floor(now.getTime() / 1000)})`,
			),
		)
		.returning({ id: agentJobs.id });
	return claimed.length ? job : null;
}

export async function skipAgentJob(db: AppDatabase, jobId: string, reason: string) {
	await db.update(agentJobs).set({ status: "skipped", reason, leaseUntil: null }).where(eq(agentJobs.id, jobId));
}

/** Puts a claimed job back with backoff, or marks it failed after the third attempt. */
export async function failAgentJob(db: AppDatabase, job: AgentJobRow, error: unknown) {
	const attempts = job.attempts + 1;
	await db
		.update(agentJobs)
		.set({
			status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
			nextAttemptAt: new Date(Date.now() + Math.min(60_000, 5_000 * 2 ** attempts)),
			leaseUntil: null,
			reason: agentProviderErrorMessage(error).slice(0, 300),
		})
		.where(eq(agentJobs.id, job.id));
}
