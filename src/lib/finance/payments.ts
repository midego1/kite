import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { financeCharges, financePayments, financeSubscriptions } from "@/db/schema/finance";
import { getEnv } from "@/lib/cloudflare";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import { FinanceRefusal, MIGRATION_PENDING_ERROR, financeTablesReady } from "./errors";

export type PaymentRow = typeof financePayments.$inferSelect;
type PaymentInsert = typeof financePayments.$inferInsert;

const PAYMENT_TABLES = ["finance_payments", "finance_payment_scans"];

const db = () => getDb(getEnv());

/** Whether migration 0094 is applied (and 0063 before it); reads only `sqlite_master`. */
export async function paymentTablesReady(): Promise<boolean> {
	const row = await getEnv()
		.DB.prepare(
			`SELECT count(*) AS present FROM sqlite_master WHERE type = 'table' AND name IN (${PAYMENT_TABLES.map(() => "?").join(", ")})`,
		)
		.bind(...PAYMENT_TABLES)
		.first<{ present: number }>();
	return Number(row?.present ?? 0) === PAYMENT_TABLES.length && (await financeTablesReady());
}

/** Runs a query on the payment tables; before migration 0094 it refuses with 409 instead of failing. */
export async function onPaymentTables<T>(run: () => Promise<T>): Promise<T> {
	if (!(await paymentTablesReady())) throw new FinanceRefusal(409, MIGRATION_PENDING_ERROR);
	try {
		return await run();
	} catch (error) {
		if (isNoSuchTableError(error)) throw new FinanceRefusal(409, MIGRATION_PENDING_ERROR);
		throw error;
	}
}

/** The id of the one row a message can give its owner, the same on every retry and scan. */
export async function paymentId(userId: string, messageId: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${userId}\n${messageId}`));
	const hex = [...new Uint8Array(digest).slice(0, 12)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return `fpay_${hex}`;
}

/** Inserts a payment unless the owner already has a row for the message (a removed one included); true when written. */
export async function insertPayment(values: PaymentInsert): Promise<boolean> {
	const inserted = await onPaymentTables(() =>
		db().insert(financePayments).values(values).onConflictDoNothing().returning({ id: financePayments.id }),
	);
	return inserted.length > 0;
}

/** Whether the owner tracks a subscription with one of these vendor keys: its documents go to that ledger instead. */
export async function tracksVendor(userId: string, vendorKeys: readonly string[]): Promise<boolean> {
	const [row] = await onPaymentTables(() =>
		db()
			.select({ id: financeSubscriptions.id })
			.from(financeSubscriptions)
			.where(and(eq(financeSubscriptions.userId, userId), inArray(financeSubscriptions.vendorKey, [...vendorKeys])))
			.limit(1),
	);
	return !!row;
}

/** Whether the owner already recorded this message in a subscription's ledger, or has a payment row for it. */
export async function messageRecorded(userId: string, messageId: string): Promise<boolean> {
	const [charge] = await onPaymentTables(() =>
		db()
			.select({ id: financeCharges.id })
			.from(financeCharges)
			.where(and(eq(financeCharges.userId, userId), eq(financeCharges.messageId, messageId)))
			.limit(1),
	);
	if (charge) return true;
	const [payment] = await db()
		.select({ id: financePayments.id })
		.from(financePayments)
		.where(and(eq(financePayments.userId, userId), eq(financePayments.messageId, messageId)))
		.limit(1);
	return !!payment;
}

/** The owner's payment rows that are not removed, newest first. */
export function ownerPayments(userId: string): Promise<PaymentRow[]> {
	return onPaymentTables(() =>
		db()
			.select()
			.from(financePayments)
			.where(and(eq(financePayments.userId, userId), isNull(financePayments.removedAt)))
			.orderBy(desc(financePayments.documentAt), desc(financePayments.createdAt)),
	);
}

/** One of the owner's payment rows, removed or not; null for anyone else. */
export async function ownerPayment(userId: string, id: string): Promise<PaymentRow | null> {
	const [row] = await onPaymentTables(() =>
		db()
			.select()
			.from(financePayments)
			.where(and(eq(financePayments.id, id), eq(financePayments.userId, userId)))
			.limit(1),
	);
	return row ?? null;
}

export async function updatePayment(userId: string, id: string, columns: Partial<PaymentInsert>): Promise<boolean> {
	const updated = await onPaymentTables(() =>
		db()
			.update(financePayments)
			.set({ ...columns, updatedAt: new Date() })
			.where(and(eq(financePayments.id, id), eq(financePayments.userId, userId)))
			.returning({ id: financePayments.id }),
	);
	return updated.length > 0;
}

/** Hides a live row; true only for the call whose update did it, so two removals never both own it. */
export async function removePaymentRow(userId: string, id: string): Promise<boolean> {
	const removed = await onPaymentTables(() =>
		db()
			.update(financePayments)
			.set({ removedAt: new Date(), updatedAt: new Date() })
			.where(and(eq(financePayments.id, id), eq(financePayments.userId, userId), isNull(financePayments.removedAt)))
			.returning({ id: financePayments.id }),
	);
	return removed.length > 0;
}

/** The message ids of the owner's subscription documents, which hide a payment row for the same message. */
export async function ledgerMessageIds(userId: string): Promise<Set<string>> {
	const rows = await onPaymentTables(() =>
		db()
			.select({ messageId: financeCharges.messageId })
			.from(financeCharges)
			.where(and(eq(financeCharges.userId, userId), isNotNull(financeCharges.messageId))),
	);
	return new Set(rows.flatMap((row) => (row.messageId ? [row.messageId] : [])));
}
