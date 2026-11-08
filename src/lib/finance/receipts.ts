import { and, asc, eq, exists, gt, isNotNull, isNull, lt, not, notExists, or, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { getDb } from "@/db";
import { mailboxAgentSettings, messages, users } from "@/db/schema";
import {
	financeCharges,
	financePayments,
	financeReceipts,
	financeReceiptSettings,
	financeSubscriptions,
} from "@/db/schema/finance";
import { moduleSettings, userModuleAccess } from "@/db/schema/modules";
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

const log = createLogger("finance");

export type ReceiptSourceTable = "finance_charges" | "finance_payments" | "finance_subscriptions";

export type ReceiptCandidate = {
	sourceTable: ReceiptSourceTable;
	sourceId: string;
	userId: string;
	mailboxId: string | null;
	messageId: string;
	attachmentId: string | null;
	vendor: string;
	docType: string | null;
	documentAt: Date;
	createdAt: Date;
};

const db = () => getDb(getEnv());

/** How long a claim stands before another sweep or backfill tick may take it over (the same shape as
 * `finance_payment_scans.lease_until`). */
const CLAIM_LEASE_MS = 5 * 60_000;

/** A `finance_receipts` row for this source that is already claimed-or-filed: `done`, `skipped`, or `pending`
 * with a lease that has not yet expired. Anything else (no row, or a `pending` claim whose run died) is still
 * a candidate. */
function claimedOrDone(table: ReceiptSourceTable, idColumn: SQLiteColumn, now: Date): SQL {
	return exists(
		db()
			.select({ one: sql`1` })
			.from(financeReceipts)
			.where(
				and(
					eq(financeReceipts.sourceTable, table),
					eq(financeReceipts.sourceId, idColumn),
					or(
						sql`${financeReceipts.status} != 'pending'`,
						and(isNotNull(financeReceipts.leaseUntil), gt(financeReceipts.leaseUntil, now)),
					),
				),
			),
	);
}

/** A row this feature's own setting, or the install's or the user's module state, already rules out: left out of
 * both the sweep and the backfill, so neither gets stuck offering a row that can never be filed for this owner.
 * `fileOneReceipt` checks the same things again before calling Drive (the authoritative gate); this is only what
 * keeps the candidate queries themselves from stalling on an owner who can never be filed for right now. */
function ownerEligible(userIdColumn: SQLiteColumn): SQL {
	return and(
		notExists(
			db()
				.select({ one: sql`1` })
				.from(financeReceiptSettings)
				.where(and(eq(financeReceiptSettings.userId, userIdColumn), eq(financeReceiptSettings.enabled, false))),
		),
		notExists(
			db()
				.select({ one: sql`1` })
				.from(moduleSettings)
				.where(and(eq(moduleSettings.moduleId, "drive"), eq(moduleSettings.enabled, false))),
		),
		notExists(
			db()
				.select({ one: sql`1` })
				.from(userModuleAccess)
				.where(
					and(
						eq(userModuleAccess.userId, userIdColumn),
						eq(userModuleAccess.moduleId, "drive"),
						eq(userModuleAccess.allowed, false),
					),
				),
		),
		notExists(
			db()
				.select({ one: sql`1` })
				.from(moduleSettings)
				.where(and(eq(moduleSettings.moduleId, "finance"), eq(moduleSettings.enabled, false))),
		),
		notExists(
			db()
				.select({ one: sql`1` })
				.from(userModuleAccess)
				.where(
					and(
						eq(userModuleAccess.userId, userIdColumn),
						eq(userModuleAccess.moduleId, "finance"),
						eq(userModuleAccess.allowed, false),
					),
				),
		),
	)!;
}

/** A mailbox with "No AI for this mailbox" on: Money Watch's own rule is that such a mailbox is never sent to an
 * AI provider or copied out by an automatic feature, so it is left out of the candidate pool entirely rather than
 * claimed and immediately skipped on every tick. */
function mailboxAiOn(mailboxIdColumn: SQLiteColumn): SQL {
	return notExists(
		db()
			.select({ one: sql`1` })
			.from(mailboxAgentSettings)
			.where(and(eq(mailboxAgentSettings.mailboxId, mailboxIdColumn), eq(mailboxAgentSettings.aiDisabled, true))),
	);
}

/** Unfiled, eligible `finance_charges` rows (a message and a subscription vendor, newest filings last). */
async function chargeCandidates(limit: number, userId?: string, createdAfter?: Date): Promise<ReceiptCandidate[]> {
	const now = new Date();
	const rows = await onReceiptTables(() =>
		db()
			.select({
				id: financeCharges.id,
				userId: financeCharges.userId,
				messageId: financeCharges.messageId,
				attachmentId: financeCharges.attachmentId,
				docType: financeCharges.docType,
				documentAt: financeCharges.documentAt,
				createdAt: financeCharges.createdAt,
				mailboxId: messages.mailboxId,
				vendor: financeSubscriptions.vendor,
			})
			.from(financeCharges)
			.innerJoin(financeSubscriptions, eq(financeSubscriptions.id, financeCharges.subscriptionId))
			.leftJoin(messages, eq(messages.id, financeCharges.messageId))
			.where(
				and(
					isNotNull(financeCharges.messageId),
					userId ? eq(financeCharges.userId, userId) : undefined,
					createdAfter ? gt(financeCharges.createdAt, createdAfter) : undefined,
					ownerEligible(financeCharges.userId),
					mailboxAiOn(messages.mailboxId),
					not(claimedOrDone("finance_charges", financeCharges.id, now)),
				),
			)
			.orderBy(asc(financeCharges.createdAt), asc(financeCharges.id))
			.limit(limit),
	);
	return rows
		.filter((row) => row.messageId)
		.map((row) => ({
			sourceTable: "finance_charges" as const,
			sourceId: row.id,
			userId: row.userId,
			mailboxId: row.mailboxId ?? null,
			messageId: row.messageId!,
			attachmentId: row.attachmentId,
			vendor: row.vendor,
			docType: row.docType,
			documentAt: row.documentAt,
			createdAt: row.createdAt,
		}));
}

/** Unfiled, eligible `finance_payments` rows (not a removed tombstone). */
async function paymentCandidates(limit: number, userId?: string, createdAfter?: Date): Promise<ReceiptCandidate[]> {
	const now = new Date();
	const rows = await onReceiptTables(() =>
		db()
			.select()
			.from(financePayments)
			.where(
				and(
					isNull(financePayments.removedAt),
					isNotNull(financePayments.messageId),
					userId ? eq(financePayments.userId, userId) : undefined,
					createdAfter ? gt(financePayments.createdAt, createdAfter) : undefined,
					ownerEligible(financePayments.userId),
					mailboxAiOn(financePayments.mailboxId),
					not(claimedOrDone("finance_payments", financePayments.id, now)),
				),
			)
			.orderBy(asc(financePayments.createdAt), asc(financePayments.id))
			.limit(limit),
	);
	return rows
		.filter((row) => row.messageId)
		.map((row) => ({
			sourceTable: "finance_payments" as const,
			sourceId: row.id,
			userId: row.userId,
			mailboxId: row.mailboxId,
			messageId: row.messageId!,
			attachmentId: row.attachmentId,
			vendor: row.vendor,
			docType: row.docType,
			documentAt: row.documentAt,
			createdAt: row.createdAt,
		}));
}

/** Unfiled, eligible `finance_subscriptions` rows: the message that started tracking it, if any. */
async function subscriptionCandidates(
	limit: number,
	userId?: string,
	createdAfter?: Date,
): Promise<ReceiptCandidate[]> {
	const now = new Date();
	const rows = await onReceiptTables(() =>
		db()
			.select()
			.from(financeSubscriptions)
			.where(
				and(
					isNotNull(financeSubscriptions.sourceMessageId),
					userId ? eq(financeSubscriptions.userId, userId) : undefined,
					createdAfter ? gt(financeSubscriptions.createdAt, createdAfter) : undefined,
					ownerEligible(financeSubscriptions.userId),
					mailboxAiOn(financeSubscriptions.mailboxId),
					not(claimedOrDone("finance_subscriptions", financeSubscriptions.id, now)),
				),
			)
			.orderBy(asc(financeSubscriptions.createdAt), asc(financeSubscriptions.id))
			.limit(limit),
	);
	return rows
		.filter((row) => row.sourceMessageId)
		.map((row) => ({
			sourceTable: "finance_subscriptions" as const,
			sourceId: row.id,
			userId: row.userId,
			mailboxId: row.mailboxId,
			messageId: row.sourceMessageId!,
			attachmentId: null,
			vendor: row.vendor,
			docType: null,
			documentAt: row.createdAt,
			createdAt: row.createdAt,
		}));
}

/** Unfiled rows across all three tables, oldest first, for the automatic sweep or one owner's backfill.
 * `createdAfter`, used only by the automatic sweep (never the explicit backfill, which must still reach a
 * user's whole history), excludes a row created at or before the sweep floor. */
export async function receiptCandidates(
	limit: number,
	userId?: string,
	createdAfter?: Date,
): Promise<ReceiptCandidate[]> {
	const [charges, payments, subscriptions] = await Promise.all([
		chargeCandidates(limit, userId, createdAfter),
		paymentCandidates(limit, userId, createdAfter),
		subscriptionCandidates(limit, userId, createdAfter),
	]);
	return [...charges, ...payments, ...subscriptions]
		.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
		.slice(0, limit);
}

function receiptYear(candidate: ReceiptCandidate): number {
	return candidate.documentAt.getUTCFullYear();
}

function receiptBaseName(candidate: ReceiptCandidate): string {
	const day = candidate.documentAt.toISOString().slice(0, 10);
	const parts = [day, candidate.vendor, candidate.docType ?? "tracked"].filter(Boolean);
	return parts.join(" ").slice(0, 150);
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
 * or, failing that (a row already exists), taking over an existing `pending` row whose lease has expired. Returns
 * `null` when the row is already `done`/`skipped`, or another run currently holds a live claim on it. */
async function claimReceipt(candidate: ReceiptCandidate): Promise<string | null> {
	const now = new Date();
	const lease = new Date(now.getTime() + CLAIM_LEASE_MS);
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
				leaseUntil: lease,
			})
			.onConflictDoNothing()
			.returning({ id: financeReceipts.id }),
	);
	if (inserted.length > 0) return inserted[0]!.id;
	const taken = await onReceiptTables(() =>
		db()
			.update(financeReceipts)
			.set({ leaseUntil: lease, updatedAt: now })
			.where(
				and(
					eq(financeReceipts.sourceTable, candidate.sourceTable),
					eq(financeReceipts.sourceId, candidate.sourceId),
					eq(financeReceipts.status, "pending"),
					or(isNull(financeReceipts.leaseUntil), lt(financeReceipts.leaseUntil, now)),
				),
			)
			.returning({ id: financeReceipts.id }),
	);
	return taken[0]?.id ?? null;
}

/**
 * Files one candidate's receipts into the owner's Drive and records the outcome. Claims the row first (a
 * `pending` `finance_receipts` row, before Drive is ever called), so a concurrent sweep and backfill tick
 * racing on the same row, or a retry after a crash, can never file it twice: only the run that wins the claim
 * calls Drive at all. Returns `false` without changing the claim for a transient failure (Drive unavailable,
 * quota full, a read error) so the lease simply expires and the row is retried; a permanent outcome (the
 * message is gone, Drive or Money Watch is off, the mailbox has no AI, or there was truly nothing to file)
 * commits the claim to `done` or `skipped` so it is never retried on its own.
 */
export async function fileOneReceipt(candidate: ReceiptCandidate): Promise<boolean> {
	if (!(await receiptsEnabledFor(candidate.userId))) return false;
	const ctx = await ownerCallContext(candidate.userId);
	if (!(await moduleHost.modules.isEnabledFor(ctx, candidate.userId, "finance"))) return false;
	if (!(await moduleHost.modules.isEnabledFor(ctx, candidate.userId, "drive"))) return false;
	if (candidate.mailboxId && (await mailboxAiOff(getEnv(), candidate.mailboxId))) return false;

	const claimId = await claimReceipt(candidate);
	if (!claimId) return false;

	const result = await moduleHost.invoke(ctx, "drive", "fileReceipt", {
		messageId: candidate.messageId,
		attachmentId: candidate.attachmentId,
		folderPath: ["Money Watch", "Receipts", String(receiptYear(candidate))],
		baseName: receiptBaseName(candidate),
	});
	if (!result.ok) {
		if (result.error.code === "module_disabled" || result.error.code === "forbidden") {
			await onReceiptTables(() =>
				db()
					.update(financeReceipts)
					.set({ status: "skipped", skippedReason: result.error.code, leaseUntil: null, updatedAt: new Date() })
					.where(eq(financeReceipts.id, claimId)),
			);
			return false;
		}
		// Transient (timeout, an uncaught quota or read error): leave the claim pending, its lease expires and the
		// row is picked up again by the next sweep tick or backfill batch.
		log.warn("finance.receipt_file_failed", {
			sourceTable: candidate.sourceTable,
			sourceId: candidate.sourceId,
			code: result.error.code,
		});
		return false;
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
		return false;
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
	return true;
}

/**
 * The ids of one owner's rows in a table that already have a filed receipt, for "this also has a Drive copy" UI
 * checks. Reads with `onReceiptTablesOr`: before migration 0101, nothing is filed yet, which is simply the true
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

/** Before migration 0101 (or on Node, a read error of the newly added column) the sweep floor cannot be read or
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
		if (await fileOneReceipt(candidate)) filed += 1;
	}
	return { filed, scanned: candidates.length };
}
