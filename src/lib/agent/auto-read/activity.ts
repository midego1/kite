import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { agentJobs } from "@/db/schema";
import { agentActions } from "@/db/schema/agent-auto-read";
import { toActivityAction } from "./actions-utils";

const ACTION_LIMIT = 100;
const SKIPPED_JOB_LIMIT = 20;
const SKIPPED_JOB_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The mailbox's audit log, newest first, plus recently skipped triage jobs and their reasons. */
export async function listAgentActivity(env: CloudflareEnv, mailboxId: string, now = new Date()) {
	const db = getDb(env);
	const rows = await db
		.select()
		.from(agentActions)
		.where(eq(agentActions.mailboxId, mailboxId))
		// Timestamps are whole seconds, so insertion order breaks ties (an undo and its inverse row share a second).
		.orderBy(desc(agentActions.createdAt), desc(sql`rowid`))
		.limit(ACTION_LIMIT);
	const skippedJobs = await db
		.select({
			id: agentJobs.id,
			reason: agentJobs.reason,
			sourceMessageId: agentJobs.sourceMessageId,
			createdAt: agentJobs.createdAt,
		})
		.from(agentJobs)
		.where(
			and(
				eq(agentJobs.mailboxId, mailboxId),
				eq(agentJobs.kind, "triage"),
				eq(agentJobs.status, "skipped"),
				gte(agentJobs.createdAt, new Date(now.getTime() - SKIPPED_JOB_WINDOW_MS)),
			),
		)
		.orderBy(desc(agentJobs.createdAt))
		.limit(SKIPPED_JOB_LIMIT);
	return {
		actions: rows.map((row) => toActivityAction(row, now)),
		skippedJobs: skippedJobs.map((job) => ({ ...job, createdAt: job.createdAt.toISOString() })),
	};
}
