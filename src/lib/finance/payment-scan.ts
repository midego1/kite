import { and, asc, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { financePaymentScans, financePayments } from "@/db/schema/finance";
import { getEnv } from "@/lib/cloudflare";
import { createLogger } from "@/lib/logger.mjs";
import { buildCallContext } from "@/lib/modules/capability-utils";
import { moduleHost } from "@/lib/modules/host";
import type { CapabilityCallContext, CapabilityHandler, JsonValue } from "@/lib/modules/module-types";
import { normalizeTimeZone } from "@/lib/time/utils";
import { recordPaymentFromInput } from "./payment-step";
import { worthScanning } from "./payment-utils";
import { onPaymentTables, paymentTablesReady } from "./payments";
import { reminderOwner } from "./reminder-store";
import type { DetectStepInput } from "./types";

const log = createLogger("finance");

/** How far back "Scan last 90 days" reads. */
const SCAN_DAYS = 90;
/** Messages one run lists; only the few that pass the prefilter have their body read. */
const PAGE_SIZE = 200;
/** A run stops handing out new work after this long, well inside the queue handler's timeout. */
const RUN_BUDGET_MS = 20_000;
/** A run's hold on a scan; a run that died is taken over once it ran out. */
const LEASE_MS = 120_000;
const SCAN_KIND = "finance.scan" as const;
const STEP_CAPABILITY = "payments";

export type ScanRow = typeof financePaymentScans.$inferSelect;

/** The agent queue message of one scan run. @public Named by `AGENT_QUEUE` in env.d.ts. */
export type PaymentScanMessage = { kind: "finance.scan"; userId: string };

export type ScanView = {
	status: "running" | "done" | "failed";
	scanned: number;
	recorded: number;
	/** Messages that could not be read and were passed over. */
	skipped: number;
	startedAt: string;
	finishedAt: string | null;
};

const db = () => getDb(getEnv());

export function scanView(row: ScanRow | null): ScanView | null {
	if (!row) return null;
	return {
		status: row.status,
		scanned: row.scanned,
		recorded: row.recorded,
		skipped: row.skipped,
		startedAt: row.startedAt.toISOString(),
		finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
	};
}

export async function ownerScan(userId: string): Promise<ScanRow | null> {
	const [row] = await onPaymentTables(() =>
		db().select().from(financePaymentScans).where(eq(financePaymentScans.userId, userId)).limit(1),
	);
	return row ?? null;
}

async function enqueueScan(userId: string, delaySeconds?: number): Promise<boolean> {
	const queue = getEnv().AGENT_QUEUE;
	if (!queue) return false;
	const message: PaymentScanMessage = { kind: SCAN_KIND, userId };
	await queue.send(message, delaySeconds ? { delaySeconds } : undefined);
	return true;
}

/**
 * Starts the owner's scan of the last 90 days, or leaves a running one alone; a finished scan starts again from the
 * beginning (rows already recorded or removed are never written twice). The work runs on the agent queue.
 */
export async function startScan(userId: string, now = new Date()): Promise<ScanRow> {
	const existing = await ownerScan(userId);
	if (existing?.status === "running") {
		// A run holds it already; only a scan nobody holds is queued again.
		if (!existing.leaseUntil || existing.leaseUntil < now) await enqueueScan(userId);
		return existing;
	}
	const since = new Date(now.getTime() - SCAN_DAYS * 86_400_000);
	const values = {
		status: "running" as const,
		sinceAt: since,
		cursorAt: null,
		cursorId: null,
		scanned: 0,
		recorded: 0,
		skipped: 0,
		leaseUntil: null,
		startedAt: now,
		updatedAt: now,
		finishedAt: null,
	};
	await onPaymentTables(() =>
		db()
			.insert(financePaymentScans)
			.values({ userId, ...values })
			.onConflictDoUpdate({ target: financePaymentScans.userId, set: values }),
	);
	await enqueueScan(userId);
	return (await ownerScan(userId))!;
}

/** Takes the scan for one run unless another run holds it; the row as taken, or null. */
async function leaseScan(userId: string, now: Date): Promise<ScanRow | null> {
	const [row] = await db()
		.update(financePaymentScans)
		.set({ leaseUntil: new Date(now.getTime() + LEASE_MS), updatedAt: now })
		.where(
			and(
				eq(financePaymentScans.userId, userId),
				eq(financePaymentScans.status, "running"),
				or(isNull(financePaymentScans.leaseUntil), lt(financePaymentScans.leaseUntil, now)),
			),
		)
		.returning();
	return row ?? null;
}

async function ownerContext(cron: CapabilityCallContext, userId: string): Promise<CapabilityCallContext | null> {
	if (!(await moduleHost.modules.isEnabledFor(cron, userId, "finance"))) return null;
	const owner = await reminderOwner(userId);
	if (!owner) return null;
	return buildCallContext({
		trigger: "cron",
		viewer: { userId, role: owner.role, isPrimaryAdmin: owner.isPrimaryAdmin },
		timeZone: normalizeTimeZone(owner.timeZone),
		requestId: cron.requestId,
		grants: cron.grants,
	});
}

type Progress = {
	scanned: number;
	recorded: number;
	skipped: number;
	cursor: { receivedAt: string; id: string } | null;
	done: boolean;
};

/** Reads one message and records its payment; true when a row was written. */
async function recordMessage(ctx: CapabilityCallContext, messageId: string): Promise<boolean> {
	const input = await moduleHost.mail.stepInput(ctx, "finance", { messageId, capability: STEP_CAPABILITY });
	return !!input && (await recordPaymentFromInput(ctx, input as unknown as DetectStepInput, "scan")) === "recorded";
}

/** One retry for a passing failure; a message that fails twice is passed over and counted, never retried forever. */
async function recordWithRetry(
	ctx: CapabilityCallContext,
	messageId: string,
): Promise<"recorded" | "none" | "skipped"> {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			return (await recordMessage(ctx, messageId)) ? "recorded" : "none";
		} catch (error) {
			if (attempt === 1) {
				log.warn("finance.scan_message_failed", { messageId, error });
				return "skipped";
			}
		}
	}
	return "skipped";
}

/** One run: a page of the owner's mail after the cursor, the prefilter, then the full step input for the rest. */
async function scanPage(ctx: CapabilityCallContext, row: ScanRow, started: number): Promise<Progress> {
	const after = row.cursorAt && row.cursorId ? { receivedAt: row.cursorAt.toISOString(), id: row.cursorId } : null;
	const page = await moduleHost.mail.backfillMessages(ctx, "finance", {
		capability: STEP_CAPABILITY,
		since: row.sinceAt.toISOString(),
		after,
		limit: PAGE_SIZE,
	});
	let scanned = 0;
	let recorded = 0;
	let skipped = 0;
	let cursor = after;
	for (const message of page.messages) {
		// At least one message per run, so a slow listing still moves the cursor.
		if (scanned > 0 && Date.now() - started > RUN_BUDGET_MS) return { scanned, recorded, skipped, cursor, done: false };
		scanned += 1;
		cursor = { receivedAt: message.receivedAt, id: message.id };
		if (!worthScanning(message)) continue;
		const outcome = await recordWithRetry(ctx, message.id);
		if (outcome === "recorded") recorded += 1;
		else if (outcome === "skipped") skipped += 1;
	}
	// The whole page was handled: move past every row read, also the ones the gate left out, so a page the gate empties
	// cannot hold the scan.
	return { scanned: page.read, recorded, skipped, cursor: page.next ?? cursor, done: page.next === null };
}

/**
 * What this scan has recorded so far, counted from the rows themselves, so a run that failed after inserting a payment
 * (and whose retry then skips it as already recorded) still counts it.
 */
async function recordedSince(userId: string, startedAt: Date): Promise<number> {
	const [row] = await db()
		.select({ count: sql<number>`count(*)` })
		.from(financePayments)
		.where(
			and(
				eq(financePayments.userId, userId),
				eq(financePayments.source, "scan"),
				gte(financePayments.createdAt, startedAt),
			),
		);
	return Number(row?.count ?? 0);
}

async function saveProgress(row: ScanRow, progress: Progress, now: Date): Promise<void> {
	await db()
		.update(financePaymentScans)
		.set({
			cursorAt: progress.cursor ? new Date(progress.cursor.receivedAt) : row.cursorAt,
			cursorId: progress.cursor?.id ?? row.cursorId,
			scanned: row.scanned + progress.scanned,
			recorded: await recordedSince(row.userId, row.startedAt),
			skipped: row.skipped + progress.skipped,
			leaseUntil: null,
			updatedAt: now,
			...(progress.done ? { status: "done" as const, finishedAt: now } : {}),
		})
		.where(eq(financePaymentScans.userId, row.userId));
}

/**
 * The `finance.scan` queue message: one leased run of an owner's scan, which hands on to the next run until the
 * cursor reaches today. Deterministic only: the scan never calls a model and sends no notice.
 */
export const scanPayments: CapabilityHandler = async (raw, cron): Promise<JsonValue> => {
	const userId = (raw as { userId?: unknown } | null)?.userId;
	if (typeof userId !== "string" || !(await paymentTablesReady())) return { scanned: 0 };
	const ctx = await ownerContext(cron, userId);
	if (!ctx) {
		// Money Watch is off for the owner: the scan waits, at the back of the recovery queue so it never blocks others.
		await db()
			.update(financePaymentScans)
			.set({ updatedAt: new Date() })
			.where(and(eq(financePaymentScans.userId, userId), eq(financePaymentScans.status, "running")));
		return { scanned: 0 };
	}
	const started = Date.now();
	const row = await leaseScan(userId, new Date(started));
	if (!row) return { scanned: 0 };
	let progress: Progress;
	try {
		progress = await scanPage(ctx, row, started);
	} catch (error) {
		await db().update(financePaymentScans).set({ leaseUntil: null }).where(eq(financePaymentScans.userId, userId));
		log.warn("finance.scan_failed", { error });
		throw error;
	}
	await saveProgress(row, progress, new Date());
	if (!progress.done) await enqueueScan(userId);
	return { scanned: progress.scanned };
};

/**
 * The five-minute safety net: a running scan whose run died (no lease, or one that ran out) is queued again, as Mail
 * import does for its jobs. Without a queue binding the run happens here.
 */
export const resumePaymentScans: CapabilityHandler = async (_input, cron): Promise<JsonValue> => {
	if (!(await paymentTablesReady())) return { resumed: 0 };
	const now = new Date();
	const stalled = await db()
		.select({ userId: financePaymentScans.userId })
		.from(financePaymentScans)
		.where(
			and(
				eq(financePaymentScans.status, "running"),
				or(isNull(financePaymentScans.leaseUntil), lt(financePaymentScans.leaseUntil, now)),
				lt(financePaymentScans.updatedAt, new Date(now.getTime() - 60_000)),
			),
		)
		.orderBy(asc(financePaymentScans.updatedAt))
		.limit(20);
	for (const { userId } of stalled)
		if (!(await enqueueScan(userId))) await scanPayments({ kind: SCAN_KIND, userId }, cron);
	return { resumed: stalled.length };
};
