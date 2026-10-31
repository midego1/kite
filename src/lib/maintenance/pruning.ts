import { and, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { getDb } from "@/db";
import {
	auditLogs,
	autoReplyDeliveries,
	loginChallenges,
	outboundJobs,
	passwordResetTokens,
	sessions,
	webhookDeliveries,
} from "@/db/schema";
import { agentActions } from "@/db/schema/agent-auto-read";
import { aiSummaries } from "@/db/schema/agent-summaries";
import { MCP_TOOL_CALL_ACTION } from "@/lib/mcp/audit";
import type { PruningPolicy, PruningResult } from "./pruning-types";
import {
	MCP_AUDIT_DAILY_MAX_BATCHES,
	MCP_AUDIT_SLICE_MS,
	PRUNABLE_OUTBOUND_JOB_STATUSES,
	PRUNABLE_WEBHOOK_DELIVERY_STATUSES,
	PRUNING_BATCH_SIZE,
	PRUNING_MAX_BATCHES_PER_TABLE,
	PRUNING_POLICY,
	getRetentionCutoff,
	shouldContinuePruning,
} from "./pruning-utils";

type Db = ReturnType<typeof getDb>;
type PrunableTable = SQLiteTable & { id: SQLiteColumn };

async function pruneInBatches(
	db: Db,
	table: PrunableTable,
	where: SQL | undefined,
	maxBatches = PRUNING_MAX_BATCHES_PER_TABLE,
): Promise<number> {
	let total = 0;
	let batches = 0;
	for (;;) {
		// D1 has no DELETE ... LIMIT, so each batch deletes by a bounded id subquery.
		const deleted = await db
			.delete(table)
			.where(inArray(table.id, db.select({ id: table.id }).from(table).where(where).limit(PRUNING_BATCH_SIZE)))
			.returning({ id: table.id });
		total += deleted.length;
		batches += 1;
		if (!shouldContinuePruning(deleted.length, batches, PRUNING_BATCH_SIZE, maxBatches)) return total;
	}
}

/**
 * The MCP tool call rows that crossed the retention cutoff in the last `MCP_AUDIT_SLICE_MS`: a bounded range of
 * `audit_logs_action_created_idx` (migration 0087; `audit_logs_created_idx` before it), so each run reads only
 * those rows, not every older audit row.
 * @public Test-only: exported so the query plan can be checked.
 */
export function mcpAuditSliceCondition(cutoff: Date): SQL {
	return and(
		gte(auditLogs.createdAt, new Date(cutoff.getTime() - MCP_AUDIT_SLICE_MS)),
		lt(auditLogs.createdAt, cutoff),
		eq(auditLogs.action, MCP_TOOL_CALL_ACTION),
	)!;
}

/**
 * MCP tool call audit rows that just passed their retention, from the five-minute cron: one row per call can
 * outgrow the daily run's budget. Up to 5,000 rows per run (about 1.4 million a day) from a 15-minute slice of
 * the `created_at` index; anything left over (heavier bursts, missed runs) goes in the daily run.
 */
export async function pruneMcpToolCallAudit(
	env: CloudflareEnv,
	now = new Date(),
	policy: PruningPolicy = PRUNING_POLICY,
): Promise<number> {
	const cutoff = getRetentionCutoff(now, policy.mcpToolCallAuditDays);
	if (!cutoff) return 0;
	return pruneInBatches(getDb(env), auditLogs, mcpAuditSliceCondition(cutoff));
}

/**
 * Delete operational rows past their retention so D1 stays small and indexes stay hot.
 * Every table is pruned independently, and a failure in one does not stop the others.
 */
export async function runDatabasePruning(
	env: CloudflareEnv,
	now = new Date(),
	policy: PruningPolicy = PRUNING_POLICY,
): Promise<PruningResult> {
	const db = getDb(env);
	const result: PruningResult = {};
	const jobs: Array<[string, PrunableTable, number, (cutoff: Date) => SQL | undefined, number?]> = [
		[
			"outbound_jobs",
			outboundJobs,
			policy.outboundJobsDays,
			(cutoff) =>
				and(inArray(outboundJobs.status, [...PRUNABLE_OUTBOUND_JOB_STATUSES]), lt(outboundJobs.updatedAt, cutoff)),
		],
		[
			"webhook_deliveries",
			webhookDeliveries,
			policy.webhookDeliveriesDays,
			(cutoff) =>
				and(
					inArray(webhookDeliveries.status, [...PRUNABLE_WEBHOOK_DELIVERY_STATUSES]),
					lt(webhookDeliveries.createdAt, cutoff),
				),
		],
		[
			"auto_reply_deliveries",
			autoReplyDeliveries,
			policy.autoReplyDeliveriesDays,
			(cutoff) => lt(autoReplyDeliveries.sentAt, cutoff),
		],
		["sessions", sessions, policy.expiredSessionsDays, (cutoff) => lt(sessions.expiresAt, cutoff)],
		[
			"login_challenges",
			loginChallenges,
			policy.expiredLoginChallengesDays,
			(cutoff) => lt(loginChallenges.expiresAt, cutoff),
		],
		[
			"password_reset_tokens",
			passwordResetTokens,
			policy.expiredPasswordResetTokensDays,
			(cutoff) => lt(passwordResetTokens.expiresAt, cutoff),
		],
		[
			// The backlog the five-minute slices missed; it reads the older audit rows once a day.
			"mcp_tool_call_audit_logs",
			auditLogs,
			policy.mcpToolCallAuditDays,
			(cutoff) => and(eq(auditLogs.action, MCP_TOOL_CALL_ACTION), lt(auditLogs.createdAt, cutoff)),
			MCP_AUDIT_DAILY_MAX_BATCHES,
		],
		["agent_actions", agentActions, policy.agentActionsDays, (cutoff) => lt(agentActions.createdAt, cutoff)],
		[
			"ai_summaries",
			aiSummaries,
			policy.staleSummariesDays,
			// Out of date since before the cutoff: a summarised message of the conversation arrived after the summary.
			(cutoff) =>
				and(
					eq(aiSummaries.kind, "thread"),
					lt(aiSummaries.updatedAt, cutoff),
					sql`exists (select 1 from messages where messages.mailbox_id = ${aiSummaries.mailboxId} and coalesce(messages.thread_id, messages.id) = ${aiSummaries.threadKey} and messages.status in ('received', 'sent', 'archived') and messages.created_at > ${aiSummaries.updatedAt} and messages.created_at < ${Math.floor(cutoff.getTime() / 1000)})`,
				),
		],
	];
	for (const [name, table, days, where, maxBatches] of jobs) {
		const cutoff = getRetentionCutoff(now, days);
		if (!cutoff) continue;
		try {
			result[name] = await pruneInBatches(db, table, where(cutoff), maxBatches);
		} catch (error) {
			console.error(`Pruning ${name} failed`, error);
		}
	}
	return result;
}
