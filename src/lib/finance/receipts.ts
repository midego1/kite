import { and, eq, isNull, lt, or } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { financeReceipts } from "@/db/schema/finance";
import { missingColumnFromError } from "@/lib/auth/user-lookup-utils";
import { APP_SETTINGS_ID } from "@/lib/branding/service";
import { getEnv } from "@/lib/cloudflare";
import { createLogger } from "@/lib/logger.mjs";
import { mailboxAiOff } from "@/lib/agent/mailbox-ai";
import { newId } from "@/lib/ids";
import { buildCallContext } from "@/lib/modules/capability-utils";
import { moduleHost } from "@/lib/modules/host";
import type { CapabilityCallContext } from "@/lib/modules/module-types";
import { onReceiptTables, onReceiptTablesOr, receiptTablesReady } from "./receipt-tables";
import { receiptsEnabledFor } from "./receipt-settings";
import { receiptCandidates, type ReceiptCandidate, type ReceiptSourceTable } from "./receipt-candidates";

export type { ReceiptCandidate, ReceiptSourceTable } from "./receipt-candidates";
export { receiptCandidates } from "./receipt-candidates";

const log = createLogger("finance");

const db = () => getDb(getEnv());

/** How long a fresh claim stands before another sweep or backfill tick may take it over (the same shape as
 * `finance_payment_scans.lease_until`). */
const CLAIM_LEASE_MS = 5 * 60_000;

/** The longest a claim backs off to: a owner stuck failing transiently (a full quota, Drive unavailable) is
 * still retried, just at most this often, instead of every tick forever. */
const MAX_CLAIM_LEASE_MS = 24 * 60 * 60_000;

/** The lease after `attempts` prior transient failures: doubles each time, capped, so a row that keeps failing
 * backs off instead of occupying every sweep tick's row budget while it cannot possibly succeed right now
 * (round-1 #5's failure mode, reached again through a stuck owner rather than a missing SQL filter). */
function claimLeaseMs(attempts: number): number {
	return Math.min(MAX_CLAIM_LEASE_MS, CLAIM_LEASE_MS * 2 ** attempts);
}

function receiptYear(candidate: ReceiptCandidate): number {
	return candidate.documentAt.getUTCFullYear();
}

/**
 * `candidate.sourceId` makes this unique per finance row: two different payments (or charges, or subscriptions)
 * due the same vendor on the same day would otherwise share a base name, and Drive's own `findExistingItem`
 * (`src/lib/drive/receipts.ts`) would then hand the second one the first's already-filed files instead of filing
 * its own. A retry of the same row keeps using this same name, which is exactly what makes a retry resume rather
 * than duplicate.
 */
/** A short, stable tag for one source row, for `receiptBaseName`'s suffix: distinct rows get distinct tags
 * without printing the row's own internal id (`payment-…`, `fchg_…`) into a file name a user sees in Drive. */
async function shortSourceTag(candidate: ReceiptCandidate): Promise<string> {
	const bytes = new TextEncoder().encode(`${candidate.sourceTable}\u0000${candidate.sourceId}`);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return hex.slice(0, 8);
}

async function receiptBaseName(candidate: ReceiptCandidate): Promise<string> {
	const day = candidate.documentAt.toISOString().slice(0, 10);
	const parts = [day, candidate.vendor, candidate.docType ?? "tracked"].filter(Boolean);
	const suffix = ` (${await shortSourceTag(candidate)})`;
	const base = parts.join(" ").slice(0, Math.max(1, 150 - suffix.length));
	return `${base}${suffix}`;
}

async function ownerCallContext(userId: string): Promise<CapabilityCallContext> {
	const [owner] = await db()
		.select({ role: users.role, isPrimaryAdmin: users.isPrimaryAdmin })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	return buildCallContext({
		viewer: { userId, role: owner?.role ?? "user", isPrimaryAdmin: owner?.isPrimaryAdmin ?? false },
		trigger: "cron",
		timeZone: "UTC",
	});
}

/** Claims a candidate for filing: a fresh `pending` row through the unique index on `(source_table, source_id)`,
 * or, failing that (a row already exists), taking over an existing `pending` row whose lease has expired. A
 * take-over counts as another attempt and grows the next lease (`claimLeaseMs`), so a row that keeps failing
 * backs off. Returns `null` when the row is already `done`/`skipped`, or another run currently holds a live
 * claim on it. */
async function claimReceipt(candidate: ReceiptCandidate): Promise<string | null> {
	const now = new Date();
	const id = newId("frcpt");
	const inserted = await onReceiptTables(() =>
		db()
			.insert(financeReceipts)
			.values({
				id,
				userId: candidate.userId,
				sourceTable: candidate.sourceTable,
				sourceId: candidate.sourceId,
				messageId: candidate.messageId,
				status: "pending",
				leaseUntil: new Date(now.getTime() + claimLeaseMs(0)),
			})
			.onConflictDoNothing()
			.returning({ id: financeReceipts.id }),
	);
	if (inserted.length > 0) return inserted[0]!.id;

	// Not a fresh claim: an unexpired or already-resolved row already exists. Read its attempt count so the
	// take-over below can grow the lease from it, then take over only if it is still exactly that row's state
	// (the `attempts` match is an optimistic lock: a second caller racing on the same take-over loses here, not
	// by corrupting the backoff count).
	const [current] = await onReceiptTables(() =>
		db()
			.select({ id: financeReceipts.id, attempts: financeReceipts.attempts })
			.from(financeReceipts)
			.where(
				and(
					eq(financeReceipts.sourceTable, candidate.sourceTable),
					eq(financeReceipts.sourceId, candidate.sourceId),
					eq(financeReceipts.status, "pending"),
					or(isNull(financeReceipts.leaseUntil), lt(financeReceipts.leaseUntil, now)),
				),
			)
			.limit(1),
	);
	if (!current) return null;
	const nextAttempts = current.attempts + 1;
	const taken = await onReceiptTables(() =>
		db()
			.update(financeReceipts)
			.set({ leaseUntil: new Date(now.getTime() + claimLeaseMs(nextAttempts)), attempts: nextAttempts, updatedAt: now })
			.where(
				and(
					eq(financeReceipts.id, current.id),
					eq(financeReceipts.status, "pending"),
					eq(financeReceipts.attempts, current.attempts),
					or(isNull(financeReceipts.leaseUntil), lt(financeReceipts.leaseUntil, now)),
				),
			)
			.returning({ id: financeReceipts.id }),
	);
	return taken[0]?.id ?? null;
}

/** `"filed"` committed the claim to `done`; `"skipped"` committed it to a permanent `skipped` (or never claimed
 * one at all: the owner's own settings refused it); `"pending"` left an existing claim exactly as it was, or
 * backed it off after a transient failure, so it is retried later rather than right away. */
export type FileReceiptOutcome = "filed" | "skipped" | "pending";

/**
 * Files one candidate's receipts into the owner's Drive and records the outcome. Claims the row first (a
 * `pending` `finance_receipts` row, before Drive is ever called), so a concurrent sweep and backfill tick
 * racing on the same row, or a retry after a crash, can never file it twice: only the run that wins the claim
 * calls Drive at all. A transient failure (Drive unavailable, quota full, a read error) backs the claim off
 * (`claimReceipt`'s growing lease) instead of changing it further, so it is retried later rather than on every
 * tick; a permanent outcome (the message is gone, Drive or Money Watch is off, the mailbox has no AI, or there
 * was truly nothing to file) commits the claim to `done` or `skipped` so it is never retried on its own.
 */
export async function fileOneReceipt(candidate: ReceiptCandidate): Promise<FileReceiptOutcome> {
	if (!(await receiptsEnabledFor(candidate.userId))) return "skipped";
	const ctx = await ownerCallContext(candidate.userId);
	if (!(await moduleHost.modules.isEnabledFor(ctx, candidate.userId, "finance"))) return "skipped";
	if (!(await moduleHost.modules.isEnabledFor(ctx, candidate.userId, "drive"))) return "skipped";
	if (candidate.mailboxId && (await mailboxAiOff(getEnv(), candidate.mailboxId))) return "skipped";

	const claimId = await claimReceipt(candidate);
	if (!claimId) return "pending";

	const result = await moduleHost.invoke(ctx, "drive", "fileReceipt", {
		messageId: candidate.messageId,
		attachmentId: candidate.attachmentId,
		folderPath: ["Money Watch", "Receipts", String(receiptYear(candidate))],
		baseName: await receiptBaseName(candidate),
	});
	if (!result.ok) {
		if (result.error.code === "module_disabled" || result.error.code === "forbidden") {
			await onReceiptTables(() =>
				db()
					.update(financeReceipts)
					.set({ status: "skipped", skippedReason: result.error.code, leaseUntil: null, updatedAt: new Date() })
					.where(eq(financeReceipts.id, claimId)),
			);
			return "skipped";
		}
		// Transient (timeout, an uncaught quota or read error): the claim was already backed off by claimReceipt
		// (a fresh claim) or the earlier take-over that won it this time; its lease expires or grows and the row
		// is picked up again by a later sweep tick or backfill batch.
		log.warn("finance.receipt_file_failed", {
			sourceTable: candidate.sourceTable,
			sourceId: candidate.sourceId,
			code: result.error.code,
		});
		return "pending";
	}
	const output = result.output as {
		filed: boolean;
		emlFileId: string | null;
		htmlFileId: string | null;
		pdfFileId: string | null;
		attachmentFileId: string | null;
		skippedReason: string | null;
	};
	if (!output.filed) {
		await onReceiptTables(() =>
			db()
				.update(financeReceipts)
				.set({
					status: "skipped",
					skippedReason: output.skippedReason ?? "unknown",
					leaseUntil: null,
					updatedAt: new Date(),
				})
				.where(eq(financeReceipts.id, claimId)),
		);
		return "skipped";
	}

	await onReceiptTables(() =>
		db()
			.update(financeReceipts)
			.set({
				emlFileId: output.emlFileId,
				htmlFileId: output.htmlFileId,
				pdfFileId: output.pdfFileId,
				attachmentFileId: output.attachmentFileId,
				status: "done",
				leaseUntil: null,
				filedAt: new Date(),
				updatedAt: new Date(),
			})
			.where(eq(financeReceipts.id, claimId)),
	);
	return "filed";
}

/**
 * Releases every one of an owner's claims still `pending` (their lease, not their `attempts`, so a row that
 * keeps failing still backs off further on its next failure instead of being hammered every time this runs),
 * so the next sweep tick or backfill batch can take them over right away instead of waiting out a lease that
 * can by now be hours long. `startReceiptBackfill` calls this: pressing "Save receipts for existing payments"
 * again is an explicit ask to retry now, and the dialog's "will be tried again automatically" line is only true
 * if pressing the button actually does that instead of silently waiting on whatever lease a stuck row already
 * holds.
 */
export async function releaseOwnerPendingClaims(userId: string): Promise<void> {
	await onReceiptTables(() =>
		db()
			.update(financeReceipts)
			.set({ leaseUntil: null, updatedAt: new Date() })
			.where(and(eq(financeReceipts.userId, userId), eq(financeReceipts.status, "pending"))),
	);
}

/**
 * The ids of one owner's rows in a table that already have a filed receipt, for "this also has a Drive copy" UI
 * checks. Reads with `onReceiptTablesOr`: before migration 0102, nothing is filed yet, which is simply the true
 * answer, not a reason for the Subscriptions or Payments view itself to read as migration-pending.
 */
export async function filedSourceIds(userId: string, table: ReceiptSourceTable): Promise<Set<string>> {
	const rows = await onReceiptTablesOr([], () =>
		db()
			.select({ sourceId: financeReceipts.sourceId })
			.from(financeReceipts)
			.where(
				and(
					eq(financeReceipts.userId, userId),
					eq(financeReceipts.sourceTable, table),
					eq(financeReceipts.status, "done"),
				),
			),
	);
	return new Set(rows.map((row) => row.sourceId));
}

/** Rows a cron tick files automatically, shortly after Money Watch records them. */
const SWEEP_ROWS_PER_TICK = 50;

/** Before migration 0102 (or on Node, a read error of the newly added column) the sweep floor cannot be read or
 * written: treated as "no floor yet", same as a fresh install. */
function beforeSweepFloorColumn(error: unknown): boolean {
	return missingColumnFromError(error) === "finance_receipts_sweep_since";
}

async function readSweepFloor(): Promise<Date | null> {
	try {
		const row = await getEnv()
			.DB.prepare("SELECT finance_receipts_sweep_since AS since FROM app_settings WHERE id = ?")
			.bind(APP_SETTINGS_ID)
			.first<{ since: number | null }>();
		return row?.since ? new Date(Number(row.since) * 1000) : null;
	} catch (error) {
		if (beforeSweepFloorColumn(error)) return null;
		throw error;
	}
}

/**
 * The automatic sweep only ever files a row created after this moment, set once, the first time the sweep ever
 * runs, to the time it first ran: a fresh deploy (or a backlog of years-old rows) never auto-files a user's whole
 * history at once in the background — that is what the explicit "Save receipts for existing payments" backfill is
 * for. Read and written as plain SQL on the `app_settings` singleton, like `attachment_storage_job`, so a deploy
 * ahead of this migration still works.
 */
async function sweepFloor(): Promise<Date> {
	const existing = await readSweepFloor();
	if (existing) return existing;
	const now = new Date();
	try {
		await getEnv()
			.DB.prepare(
				"UPDATE app_settings SET finance_receipts_sweep_since = ? WHERE id = ? AND finance_receipts_sweep_since IS NULL",
			)
			.bind(Math.floor(now.getTime() / 1000), APP_SETTINGS_ID)
			.run();
	} catch (error) {
		if (!beforeSweepFloorColumn(error)) throw error;
	}
	return (await readSweepFloor()) ?? now;
}

/** The automatic "Keep receipts" sweep: unfiled rows across every owner, created after the sweep floor, oldest
 * first, bounded per tick. */
export async function sweepReceipts(limit = SWEEP_ROWS_PER_TICK): Promise<{ filed: number; scanned: number }> {
	if (!(await receiptTablesReady())) return { filed: 0, scanned: 0 };
	const floor = await sweepFloor();
	const candidates = await receiptCandidates(limit, undefined, floor);
	let filed = 0;
	for (const candidate of candidates) {
		if ((await fileOneReceipt(candidate)) === "filed") filed += 1;
	}
	return { filed, scanned: candidates.length };
}
