import type { PruningPolicy } from "./pruning-types";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Rows removed per DELETE, and the most batches one table may take per run, so a backlog drains over several days. */
export const PRUNING_BATCH_SIZE = 500;
export const PRUNING_MAX_BATCHES_PER_TABLE = 10;

/**
 * Retention for operational rows that nothing reads once they are old.
 * Days count from the column each pruner filters on; 0 means "as soon as expired".
 */
export const PRUNING_POLICY: PruningPolicy = {
	// Finished send jobs keep the full message payload; the message row itself stays.
	outboundJobsDays: 30,
	// The webhook delivery log in Settings only needs recent history.
	webhookDeliveriesDays: 30,
	// Auto-replies are throttled per recipient for 24 hours, so older rows are never consulted.
	autoReplyDeliveriesDays: 7,
	// Expired credentials are already rejected; a short grace keeps them visible for debugging.
	expiredSessionsDays: 1,
	expiredLoginChallengesDays: 1,
	expiredPasswordResetTokensDays: 1,
};

export const PRUNABLE_OUTBOUND_JOB_STATUSES = ["sent", "failed", "cancelled"] as const;
export const PRUNABLE_WEBHOOK_DELIVERY_STATUSES = ["delivered", "exhausted", "failed"] as const;

/** Rows older than this instant are due for pruning. Invalid or negative day counts never prune. */
export function getRetentionCutoff(now: Date, days: number): Date | null {
	if (!Number.isFinite(days) || days < 0) return null;
	const time = now.getTime();
	if (!Number.isFinite(time)) return null;
	return new Date(time - days * DAY_MS);
}

/** Whether another batch is worth running: the previous one was full and the per-table budget remains. */
export function shouldContinuePruning(
	deletedInBatch: number,
	batchesRun: number,
	batchSize = PRUNING_BATCH_SIZE,
	maxBatches = PRUNING_MAX_BATCHES_PER_TABLE,
): boolean {
	return deletedInBatch >= batchSize && batchesRun < maxBatches;
}
