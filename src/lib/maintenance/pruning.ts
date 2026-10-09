import { and, inArray, lt, type SQL } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { getDb } from "@/db";
import {
	autoReplyDeliveries,
	loginChallenges,
	outboundJobs,
	passwordResetTokens,
	sessions,
	webhookDeliveries,
} from "@/db/schema";
import type { PruningPolicy, PruningResult } from "./pruning-types";
import {
	PRUNABLE_OUTBOUND_JOB_STATUSES,
	PRUNABLE_WEBHOOK_DELIVERY_STATUSES,
	PRUNING_BATCH_SIZE,
	PRUNING_POLICY,
	getRetentionCutoff,
	shouldContinuePruning,
} from "./pruning-utils";

type Db = ReturnType<typeof getDb>;
type PrunableTable = SQLiteTable & { id: SQLiteColumn };

async function pruneInBatches(db: Db, table: PrunableTable, where: SQL | undefined): Promise<number> {
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
		if (!shouldContinuePruning(deleted.length, batches)) return total;
	}
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
	const jobs: Array<[string, PrunableTable, number, (cutoff: Date) => SQL | undefined]> = [
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
	];
	for (const [name, table, days, where] of jobs) {
		const cutoff = getRetentionCutoff(now, days);
		if (!cutoff) continue;
		try {
			result[name] = await pruneInBatches(db, table, where(cutoff));
		} catch (error) {
			console.error(`Pruning ${name} failed`, error);
		}
	}
	return result;
}
