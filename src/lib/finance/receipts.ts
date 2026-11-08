import { and, asc, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { getDb } from "@/db";
import { messages, users } from "@/db/schema";
import { financeCharges, financePayments, financeReceipts, financeSubscriptions } from "@/db/schema/finance";
import { getEnv } from "@/lib/cloudflare";
import { createLogger } from "@/lib/logger.mjs";
import { mailboxAiOff } from "@/lib/agent/mailbox-ai";
import { newId } from "@/lib/ids";
import { buildCallContext } from "@/lib/modules/capability-utils";
import { moduleHost } from "@/lib/modules/host";
import type { CapabilityCallContext } from "@/lib/modules/module-types";
import { onReceiptTables, receiptTablesReady } from "./receipt-tables";
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

const notFiled = (table: ReceiptSourceTable, idColumn: SQLiteColumn): SQL =>
	sql`NOT EXISTS (SELECT 1 FROM ${financeReceipts} WHERE ${financeReceipts.sourceTable} = ${table} AND ${financeReceipts.sourceId} = ${idColumn})`;

/** Unfiled, eligible `finance_charges` rows (a message and a subscription vendor, newest filings last). */
async function chargeCandidates(limit: number, userId?: string): Promise<ReceiptCandidate[]> {
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
					notFiled("finance_charges", financeCharges.id),
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
async function paymentCandidates(limit: number, userId?: string): Promise<ReceiptCandidate[]> {
	const rows = await onReceiptTables(() =>
		db()
			.select()
			.from(financePayments)
			.where(
				and(
					isNull(financePayments.removedAt),
					isNotNull(financePayments.messageId),
					userId ? eq(financePayments.userId, userId) : undefined,
					notFiled("finance_payments", financePayments.id),
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
async function subscriptionCandidates(limit: number, userId?: string): Promise<ReceiptCandidate[]> {
	const rows = await onReceiptTables(() =>
		db()
			.select()
			.from(financeSubscriptions)
			.where(
				and(
					isNotNull(financeSubscriptions.sourceMessageId),
					userId ? eq(financeSubscriptions.userId, userId) : undefined,
					notFiled("finance_subscriptions", financeSubscriptions.id),
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

/** Unfiled rows across all three tables, oldest first, for the automatic sweep or one owner's backfill. */
export async function receiptCandidates(limit: number, userId?: string): Promise<ReceiptCandidate[]> {
	const [charges, payments, subscriptions] = await Promise.all([
		chargeCandidates(limit, userId),
		paymentCandidates(limit, userId),
		subscriptionCandidates(limit, userId),
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

/**
 * Files one candidate's receipts into the owner's Drive and records the outcome. Writes nothing and
 * returns `false` for a transient failure (Drive unavailable, quota full) so the row is retried; a
 * permanent skip (the message is gone, Drive or Money Watch is off, the mailbox has no AI) is recorded
 * so it is never retried on its own.
 */
export async function fileOneReceipt(candidate: ReceiptCandidate): Promise<boolean> {
	const skip = async (reason: string) => {
		await onReceiptTables(() =>
			db()
				.insert(financeReceipts)
				.values({
					id: newId("frcpt"),
					userId: candidate.userId,
					sourceTable: candidate.sourceTable,
					sourceId: candidate.sourceId,
					messageId: candidate.messageId,
					status: "skipped",
					skippedReason: reason,
				})
				.onConflictDoNothing(),
		);
		return true;
	};

	if (!(await receiptsEnabledFor(candidate.userId))) return false;
	const ctx = await ownerCallContext(candidate.userId);
	if (!(await moduleHost.modules.isEnabledFor(ctx, candidate.userId, "drive"))) return false;
	if (candidate.mailboxId && (await mailboxAiOff(getEnv(), candidate.mailboxId))) return false;

	const result = await moduleHost.invoke(ctx, "drive", "fileReceipt", {
		messageId: candidate.messageId,
		attachmentId: candidate.attachmentId,
		folderPath: ["Money Watch", "Receipts", String(receiptYear(candidate))],
		baseName: receiptBaseName(candidate),
	});
	if (!result.ok) {
		if (result.error.code === "module_disabled" || result.error.code === "forbidden") return false;
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
	if (!output.filed) return skip(output.skippedReason ?? "unknown");

	await onReceiptTables(() =>
		db()
			.insert(financeReceipts)
			.values({
				id: newId("frcpt"),
				userId: candidate.userId,
				sourceTable: candidate.sourceTable,
				sourceId: candidate.sourceId,
				messageId: candidate.messageId,
				emlFileId: output.emlFileId,
				htmlFileId: output.htmlFileId,
				pdfFileId: output.pdfFileId,
				attachmentFileId: output.attachmentFileId,
				status: "done",
				filedAt: new Date(),
			})
			.onConflictDoNothing(),
	);
	return true;
}

/** The ids of one owner's rows in a table that already have a filed receipt, for "this also has a Drive copy" UI checks. */
export async function filedSourceIds(userId: string, table: ReceiptSourceTable): Promise<Set<string>> {
	const rows = await onReceiptTables(() =>
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

/** The automatic "Keep receipts" sweep: unfiled rows across every owner, oldest first, bounded per tick. */
export async function sweepReceipts(limit = SWEEP_ROWS_PER_TICK): Promise<{ filed: number; scanned: number }> {
	if (!(await receiptTablesReady())) return { filed: 0, scanned: 0 };
	const candidates = await receiptCandidates(limit);
	let filed = 0;
	for (const candidate of candidates) {
		if (await fileOneReceipt(candidate)) filed += 1;
	}
	return { filed, scanned: candidates.length };
}
