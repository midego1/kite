import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { financeReceiptBackfills } from "@/db/schema/finance";
import { getEnv } from "@/lib/cloudflare";
import { createLogger } from "@/lib/logger.mjs";
import type { CapabilityHandler, JsonValue } from "@/lib/modules/module-types";
import { fileOneReceipt, receiptCandidates, releaseOwnerPendingClaims } from "./receipts";
import { onReceiptTables, receiptTablesReady } from "./receipt-tables";

const log = createLogger("finance");

/** Rows a batch files before handing off to the next run; keeps one run well inside the queue timeout. */
const BATCH_SIZE = 50;
const RUN_BUDGET_MS = 20_000;
const LEASE_MS = 120_000;
const BACKFILL_KIND = "finance.receipts_backfill" as const;

export type BackfillMessage = { kind: typeof BACKFILL_KIND; userId: string };

export type BackfillRow = typeof financeReceiptBackfills.$inferSelect;

export type BackfillView = {
	status: "running" | "done" | "failed";
	scanned: number;
	filed: number;
	skipped: number;
	pending: number;
	startedAt: string;
	finishedAt: string | null;
};

const db = () => getDb(getEnv());

export function backfillView(row: BackfillRow | null): BackfillView | null {
	if (!row) return null;
	return {
		status: row.status,
		scanned: row.scanned,
		filed: row.filed,
		skipped: row.skipped,
		pending: row.pending,
		startedAt: row.startedAt.toISOString(),
		finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
	};
}

export async function ownerBackfill(userId: string): Promise<BackfillRow | null> {
	const [row] = await onReceiptTables(() =>
		db().select().from(financeReceiptBackfills).where(eq(financeReceiptBackfills.userId, userId)).limit(1),
	);
	return row ?? null;
}

async function enqueueBackfill(userId: string, delaySeconds?: number): Promise<boolean> {
	const queue = getEnv().AGENT_QUEUE;
	if (!queue) return false;
	const message: BackfillMessage = { kind: BACKFILL_KIND, userId };
	await queue.send(message, delaySeconds ? { delaySeconds } : undefined);
	return true;
}

/**
 * Starts "Save receipts for existing payments", or leaves a running one alone. Releasing the owner's pending
 * claims first is what makes this an actual retry rather than a report that a batch will find nothing new: a
 * row a transient failure left pending still holds its lease (now up to 24 hours long, after backing off), so
 * without this, pressing the button again right after fixing whatever was wrong (freeing quota, say) would run
 * a batch that cannot even see that row yet.
 */
export async function startReceiptBackfill(userId: string, now = new Date()): Promise<BackfillRow> {
	const existing = await ownerBackfill(userId);
	if (existing?.status === "running") {
		if (!existing.leaseUntil || existing.leaseUntil < now) await enqueueBackfill(userId);
		return existing;
	}
	await releaseOwnerPendingClaims(userId);
	const values = {
		status: "running" as const,
		scanned: 0,
		filed: 0,
		skipped: 0,
		pending: 0,
		leaseUntil: null,
		startedAt: now,
		updatedAt: now,
		finishedAt: null,
	};
	await onReceiptTables(() =>
		db()
			.insert(financeReceiptBackfills)
			.values({ userId, ...values })
			.onConflictDoUpdate({
				target: financeReceiptBackfills.userId,
				set: values,
				// A second press racing the first one's insert must not reset the run that just started (or any run
				// still going): only a finished backfill is started over.
				setWhere: sql`${financeReceiptBackfills.status} != 'running'`,
			}),
	);
	await enqueueBackfill(userId);
	return (await ownerBackfill(userId))!;
}

async function leaseBackfill(userId: string, now: Date): Promise<BackfillRow | null> {
	const [row] = await db()
		.update(financeReceiptBackfills)
		.set({ leaseUntil: new Date(now.getTime() + LEASE_MS), updatedAt: now })
		.where(
			and(
				eq(financeReceiptBackfills.userId, userId),
				eq(financeReceiptBackfills.status, "running"),
				or(isNull(financeReceiptBackfills.leaseUntil), lt(financeReceiptBackfills.leaseUntil, now)),
			),
		)
		.returning();
	return row ?? null;
}

/**
 * Runs batches until none are left or the time budget runs out. `attempted` keeps a transient failure
 * (still unfiled, so it reappears in the next fetch) from being retried in a tight loop within one run;
 * it gets another try, under its own backed-off lease (`claimLeaseMs`), on a later run.
 */
async function runBatch(
	userId: string,
	started: number,
): Promise<{ scanned: number; filed: number; skipped: number; pending: number; done: boolean }> {
	let scanned = 0;
	let filed = 0;
	let skipped = 0;
	let pending = 0;
	const attempted = new Set<string>();
	for (;;) {
		if (scanned > 0 && Date.now() - started > RUN_BUDGET_MS) return { scanned, filed, skipped, pending, done: false };
		const candidates = (await receiptCandidates(BATCH_SIZE + attempted.size, userId)).filter(
			(candidate) => !attempted.has(candidate.sourceId),
		);
		if (candidates.length === 0) return { scanned, filed, skipped, pending, done: true };
		for (const candidate of candidates.slice(0, BATCH_SIZE)) {
			attempted.add(candidate.sourceId);
			scanned += 1;
			const outcome = await fileOneReceipt(candidate);
			if (outcome === "filed") filed += 1;
			else if (outcome === "pending") pending += 1;
			else skipped += 1;
			if (Date.now() - started > RUN_BUDGET_MS) return { scanned, filed, skipped, pending, done: false };
		}
	}
}

/**
 * The `finance.receipts_backfill` queue message: one leased run of an owner's backfill. `done` means this pass
 * found nothing left to try right now, not that every row succeeded or was permanently skipped: `pending` is
 * rows a transient failure (a full quota, Drive unavailable) left retryable, backed off under their own claim's
 * lease rather than this run's; it only clears once those leases pass and a later run (automatic or by pressing
 * the button again) retries them.
 */
export const backfillReceipts: CapabilityHandler = async (raw): Promise<JsonValue> => {
	const userId = (raw as { userId?: unknown } | null)?.userId;
	if (typeof userId !== "string" || !(await receiptTablesReady())) return { scanned: 0 };
	const started = Date.now();
	const row = await leaseBackfill(userId, new Date(started));
	if (!row) return { scanned: 0 };
	let progress: { scanned: number; filed: number; skipped: number; pending: number; done: boolean };
	try {
		progress = await runBatch(userId, started);
	} catch (error) {
		await db()
			.update(financeReceiptBackfills)
			.set({ leaseUntil: null })
			.where(eq(financeReceiptBackfills.userId, userId));
		log.warn("finance.receipt_backfill_failed", { userId, error });
		throw error;
	}
	const now = new Date();
	await db()
		.update(financeReceiptBackfills)
		.set({
			scanned: row.scanned + progress.scanned,
			filed: row.filed + progress.filed,
			skipped: row.skipped + progress.skipped,
			// A snapshot of this batch, not a running total: a row counted pending here may already have been
			// retried (filed or permanently skipped) by the time the next batch runs, once its lease passes.
			pending: progress.pending,
			leaseUntil: null,
			updatedAt: now,
			...(progress.done ? { status: "done" as const, finishedAt: now } : {}),
		})
		.where(eq(financeReceiptBackfills.userId, userId));
	if (!progress.done) await enqueueBackfill(userId);
	return { scanned: progress.scanned };
};

/** The five-minute safety net: a running backfill whose run died is queued again. */
export const resumeReceiptBackfills: CapabilityHandler = async (_input, ctx): Promise<JsonValue> => {
	if (!(await receiptTablesReady())) return { resumed: 0 };
	const now = new Date();
	const stalled = await db()
		.select({ userId: financeReceiptBackfills.userId })
		.from(financeReceiptBackfills)
		.where(
			and(
				eq(financeReceiptBackfills.status, "running"),
				or(isNull(financeReceiptBackfills.leaseUntil), lt(financeReceiptBackfills.leaseUntil, now)),
				lt(financeReceiptBackfills.updatedAt, new Date(now.getTime() - 60_000)),
			),
		)
		.limit(20);
	for (const { userId } of stalled)
		if (!(await enqueueBackfill(userId))) await backfillReceipts({ kind: BACKFILL_KIND, userId }, ctx);
	return { resumed: stalled.length };
};
