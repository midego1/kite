import { and, asc, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { financePaymentScans, financePayments } from "@/db/schema/finance";
import { missingColumnFromError } from "@/lib/auth/user-lookup-utils";
import { getEnv } from "@/lib/cloudflare";
import { insertRow, selectRows } from "@/lib/db/pending-columns";
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

/** How far back "Scan last 90 days" reads. @public Read by `listPaymentsView` to report mail the scan never covers. */
export const SCAN_DAYS = 90;
/** Messages one run lists; only the few that pass the prefilter have their body read. */
const PAGE_SIZE = 200;
/** A run stops handing out new work after this long, well inside the queue handler's timeout. */
const RUN_BUDGET_MS = 20_000;
/** A run's hold on a scan; a run that died is taken over once it ran out. */
const LEASE_MS = 120_000;
/**
 * A running scan the five-minute safety net could not revive for this long is given up on instead of requeued
 * forever, as `failStaleBackups` does for backups; the owner sees Try again instead of a silent retry loop.
 */
const STALE_SCAN_FAILED_AFTER_MS = 30 * 60_000;
const SCAN_STALLED_ERROR = "The scan stopped making progress and could not be resumed.";
const SCAN_KIND = "finance.scan" as const;
const STEP_CAPABILITY = "payments";

type ScanRow = typeof financePaymentScans.$inferSelect;
/** What `startScan` and the Payments tab need to report a scan's status, never its cursor. */
type ScanStatus = Pick<
	ScanRow,
	"userId" | "status" | "scanned" | "recorded" | "skipped" | "startedAt" | "finishedAt" | "leaseUntil"
>;
/** What one run needs to pick up a leased scan's cursor; never the columns the Payments tab reports. */
type LeasedScan = Pick<ScanRow, "userId" | "sinceAt" | "cursorAt" | "cursorId" | "scanned" | "skipped" | "startedAt">;

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

export function scanView(row: ScanStatus | null): ScanView | null {
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

/**
 * The owner's scan status, never its cursor (`leaseScan` reads that). Named columns only, so a deploy ahead of a
 * migration that only adds a cursor or bookkeeping column (none pending today) would still read this row.
 */
export async function ownerScan(userId: string): Promise<ScanStatus | null> {
	const [row] = await onPaymentTables(() =>
		db()
			.select({
				userId: financePaymentScans.userId,
				status: financePaymentScans.status,
				scanned: financePaymentScans.scanned,
				recorded: financePaymentScans.recorded,
				skipped: financePaymentScans.skipped,
				startedAt: financePaymentScans.startedAt,
				finishedAt: financePaymentScans.finishedAt,
				leaseUntil: financePaymentScans.leaseUntil,
			})
			.from(financePaymentScans)
			.where(eq(financePaymentScans.userId, userId))
			.limit(1),
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
export async function startScan(userId: string, now = new Date()): Promise<ScanStatus> {
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
	await onPaymentTables(async () => {
		const pg = db();
		try {
			await pg
				.insert(financePaymentScans)
				.values({ userId, ...values })
				.onConflictDoUpdate({ target: financePaymentScans.userId, set: values });
		} catch (error) {
			if (!missingColumnFromError(error)) throw error;
			// Migration 0095 not applied yet: `values` never names `error` or `progress_at`, but a single-row insert
			// still fills in every nullable, default-less column of the schema, those two included. `insertRow`'s own
			// retry drops exactly the missing ones (both are already null here, so nothing is lost) to get the row to
			// exist; the update that follows only ever names `values`' own columns, which never has this problem.
			await insertRow(pg, financePaymentScans, { userId, ...values }, { ignoreConflict: true });
			await pg.update(financePaymentScans).set(values).where(eq(financePaymentScans.userId, userId));
		}
	});
	await enqueueScan(userId);
	return (await ownerScan(userId))!;
}

/** Takes the scan for one run unless another run holds it; the row as taken, or null. */
async function leaseScan(userId: string, now: Date): Promise<LeasedScan | null> {
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
		.returning({
			userId: financePaymentScans.userId,
			sinceAt: financePaymentScans.sinceAt,
			cursorAt: financePaymentScans.cursorAt,
			cursorId: financePaymentScans.cursorId,
			scanned: financePaymentScans.scanned,
			skipped: financePaymentScans.skipped,
			startedAt: financePaymentScans.startedAt,
		});
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
async function scanPage(ctx: CapabilityCallContext, row: LeasedScan, started: number): Promise<Progress> {
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

/**
 * A page this run actually handled, whether or not it recorded anything: `progressAt` is the only place real
 * forward movement is timestamped, never `updatedAt` (`leaseScan` bumps that on every pickup, crashed run included),
 * so the five-minute safety net can tell a scan that keeps being leased and crashing from one making progress.
 * `progress_at` is a column migration 0095 adds; a deploy ahead of it just saves without it.
 */
async function saveProgress(row: LeasedScan, progress: Progress, now: Date): Promise<void> {
	const set = {
		cursorAt: progress.cursor ? new Date(progress.cursor.receivedAt) : row.cursorAt,
		cursorId: progress.cursor?.id ?? row.cursorId,
		scanned: row.scanned + progress.scanned,
		recorded: await recordedSince(row.userId, row.startedAt),
		skipped: row.skipped + progress.skipped,
		leaseUntil: null,
		updatedAt: now,
		...(progress.done ? { status: "done" as const, finishedAt: now } : {}),
	};
	try {
		await db()
			.update(financePaymentScans)
			.set({ ...set, progressAt: now })
			.where(eq(financePaymentScans.userId, row.userId));
	} catch (error) {
		if (missingColumnFromError(error) !== "progress_at") throw error;
		await db().update(financePaymentScans).set(set).where(eq(financePaymentScans.userId, row.userId));
	}
}

/** The owner's notice once a scan finishes, over the same realtime path as a renewal reminder. */
function scanFinishedNotice(recorded: number) {
	const title =
		recorded === 1 ? "Payment scan finished: 1 payment found" : `Payment scan finished: ${recorded} payments found`;
	return { notice: "scan_finished", title, href: "/finance?tab=payments" };
}

/**
 * The `finance.scan` queue message: one leased run of an owner's scan, which hands on to the next run until the
 * cursor reaches today. Deterministic only: the scan never calls a model. A finished scan sends a realtime notice,
 * so the owner hears about it after leaving the page; a notice that fails to send never fails the scan.
 */
export const scanPayments: CapabilityHandler = async (raw, cron): Promise<JsonValue> => {
	const userId = (raw as { userId?: unknown } | null)?.userId;
	if (typeof userId !== "string" || !(await paymentTablesReady())) return { scanned: 0 };
	const ctx = await ownerContext(cron, userId);
	if (!ctx) {
		// Money Watch is off for the owner: the scan waits, at the back of the recovery queue so it never blocks
		// others, for as long as it takes; `progressAt` moves too, so the 30-minute safety net never mistakes a
		// deliberate, possibly long wait for a stuck scan and fails it before Money Watch is back on.
		const waiting = new Date();
		const condition = and(eq(financePaymentScans.userId, userId), eq(financePaymentScans.status, "running"));
		try {
			await db().update(financePaymentScans).set({ updatedAt: waiting, progressAt: waiting }).where(condition);
		} catch (error) {
			if (missingColumnFromError(error) !== "progress_at") throw error;
			await db().update(financePaymentScans).set({ updatedAt: waiting }).where(condition);
		}
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
	if (!progress.done) {
		await enqueueScan(userId);
	} else {
		const finished = await ownerScan(userId);
		if (finished)
			try {
				await moduleHost.notify(ctx, "finance", [userId], scanFinishedNotice(finished.recorded));
			} catch (error) {
				log.warn("finance.scan_notify_failed", { error });
			}
	}
	return { scanned: progress.scanned };
};

/** The lease and freshness condition a row must still meet to count as stalled, re-checked at write time (below). */
function stalledCondition(now: Date) {
	return and(
		eq(financePaymentScans.status, "running"),
		or(isNull(financePaymentScans.leaseUntil), lt(financePaymentScans.leaseUntil, now)),
		lt(financePaymentScans.updatedAt, new Date(now.getTime() - 60_000)),
	);
}

/**
 * Gives up on a scan stalled past `STALE_SCAN_FAILED_AFTER_MS`: `error` is a column migration 0095 adds, so a
 * deploy ahead of it just updates the other columns, as `aiOffSince` does for `ai_disabled_at`. The same lease and
 * freshness condition the caller selected on is repeated in the `WHERE`, so a run that leased and started making
 * progress between that read and this write is never clobbered; true when a row actually matched and was failed.
 * @public Exercised directly by the bundled unit tests, which can otherwise only see the two sides of the race from
 * the same tick.
 */
export async function failStalledScan(userId: string, now: Date): Promise<boolean> {
	const condition = and(eq(financePaymentScans.userId, userId), stalledCondition(now));
	const set = { status: "failed" as const, finishedAt: now, leaseUntil: null, updatedAt: now };
	const returning = { userId: financePaymentScans.userId };
	try {
		return (
			(
				await db()
					.update(financePaymentScans)
					.set({ ...set, error: SCAN_STALLED_ERROR })
					.where(condition)
					.returning(returning)
			).length > 0
		);
	} catch (error) {
		if (missingColumnFromError(error) !== "error") throw error;
		return (await db().update(financePaymentScans).set(set).where(condition).returning(returning)).length > 0;
	}
}

/**
 * The five-minute safety net: a running scan whose run died (no lease, or one that ran out) is queued again, as Mail
 * import does for its jobs, unless `progressAt` (or `startedAt`, before any page has saved) shows no real progress
 * for `STALE_SCAN_FAILED_AFTER_MS`, which it gives up on instead (`failStalledScan`) so the owner sees Try again
 * instead of a silent retry loop. `updatedAt` alone could not drive this: `leaseScan` bumps it on every pickup, so a
 * run that leases and crashes every cycle would never go stale by that measure. Without a queue binding a resumed
 * run happens here. `selectRows` reads the whole row so a deploy ahead of migration 0095 still sees `progressAt` as
 * null (never pending) instead of failing the query that finds stalled scans at all.
 */
export const resumePaymentScans: CapabilityHandler = async (_input, cron): Promise<JsonValue> => {
	if (!(await paymentTablesReady())) return { resumed: 0, failed: 0 };
	const now = new Date();
	const stalled = await selectRows(
		db(),
		financePaymentScans,
		stalledCondition(now),
		20,
		asc(financePaymentScans.updatedAt),
	);
	let resumed = 0;
	let failed = 0;
	for (const row of stalled) {
		// Never just `progressAt`: Try again resets `startedAt` to the restart but leaves a previous run's
		// `progressAt` exactly as it was (`startScan` never writes it, only a page save or the Money-Watch-off wait
		// does), so the later of the two is this attempt's own clock.
		const progressSince = new Date(Math.max(row.progressAt?.getTime() ?? 0, row.startedAt.getTime()));
		if (now.getTime() - progressSince.getTime() > STALE_SCAN_FAILED_AFTER_MS) {
			if (await failStalledScan(row.userId, now)) failed += 1;
			continue;
		}
		if (!(await enqueueScan(row.userId))) await scanPayments({ kind: SCAN_KIND, userId: row.userId }, cron);
		resumed += 1;
	}
	return { resumed, failed };
};
