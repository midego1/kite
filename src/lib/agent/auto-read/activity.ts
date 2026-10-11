import { and, desc, eq, gte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { getDb } from "@/db";
import { agentJobs, messages } from "@/db/schema";
import { agentActions } from "@/db/schema/agent-auto-read";
import { toActivityAction } from "./actions-utils";

const ACTION_LIMIT = 100;
const SKIPPED_JOB_LIMIT = 20;
const SKIPPED_JOB_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const drafts = alias(messages, "draft");

/**
 * The mailbox's audit log, newest first, plus recently skipped triage jobs and their reasons.
 * `draftAvailable` tells whether the viewer can open the row's draft: agent drafts are private to the
 * reviewer, and a discarded draft is gone.
 */
export async function listAgentActivity(env: CloudflareEnv, mailboxId: string, viewerId: string, now = new Date()) {
	const db = getDb(env);
	const rows = await db
		.select({
			action: agentActions,
			subject: messages.subject,
			draftUserId: drafts.userId,
			draftStatus: drafts.status,
		})
		.from(agentActions)
		.leftJoin(messages, eq(messages.id, agentActions.messageId))
		.leftJoin(drafts, eq(drafts.id, sql`json_extract(${agentActions.after}, '$.draftId')`))
		.where(eq(agentActions.mailboxId, mailboxId))
		// Timestamps are whole seconds, so insertion order breaks ties (an undo and its inverse row share a second).
		.orderBy(desc(agentActions.createdAt), desc(sql`agent_actions.rowid`))
		.limit(ACTION_LIMIT);
	const skippedJobs = await db
		.select({
			id: agentJobs.id,
			reason: agentJobs.reason,
			sourceMessageId: agentJobs.sourceMessageId,
			subject: messages.subject,
			createdAt: agentJobs.createdAt,
		})
		.from(agentJobs)
		.leftJoin(messages, eq(messages.id, agentJobs.sourceMessageId))
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
		actions: rows.map((row) => ({
			...toActivityAction(row.action, now),
			subject: row.subject,
			draftAvailable: row.draftStatus === "draft" && row.draftUserId === viewerId,
		})),
		skippedJobs: skippedJobs.map((job) => ({ ...job, createdAt: job.createdAt.toISOString() })),
	};
}
