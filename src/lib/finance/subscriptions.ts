import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { financeCharges, financeSubscriptions } from "@/db/schema/finance";
import { getEnv } from "@/lib/cloudflare";
import { onFinanceTables } from "./errors";
import type { ChargeRow, SubscriptionRow } from "./record-utils";

/** At most this many documents are snapshotted when a subscription is removed (spec §9.1). */
export const SNAPSHOT_DOCUMENTS = 200;

const db = () => getDb(getEnv());

type SubscriptionInsert = typeof financeSubscriptions.$inferInsert;
type ChargeInsert = typeof financeCharges.$inferInsert;

export function ownerRows(userId: string, vendorKey?: string): Promise<SubscriptionRow[]> {
	const owner = eq(financeSubscriptions.userId, userId);
	return onFinanceTables(() =>
		db()
			.select()
			.from(financeSubscriptions)
			.where(vendorKey ? and(owner, eq(financeSubscriptions.vendorKey, vendorKey)) : owner)
			.orderBy(financeSubscriptions.createdAt),
	);
}

export async function ownerRow(userId: string, id: string): Promise<SubscriptionRow | null> {
	const [row] = await onFinanceTables(() =>
		db()
			.select()
			.from(financeSubscriptions)
			.where(and(eq(financeSubscriptions.id, id), eq(financeSubscriptions.userId, userId)))
			.limit(1),
	);
	return row ?? null;
}

/** Inserts a subscription unless its id exists; true when this call wrote it. */
export async function insertSubscription(values: SubscriptionInsert): Promise<boolean> {
	const inserted = await onFinanceTables(() =>
		db().insert(financeSubscriptions).values(values).onConflictDoNothing().returning({ id: financeSubscriptions.id }),
	);
	return inserted.length > 0;
}

export async function updateSubscription(
	userId: string,
	id: string,
	columns: Partial<SubscriptionInsert>,
): Promise<boolean> {
	const updated = await onFinanceTables(() =>
		db()
			.update(financeSubscriptions)
			.set({ ...columns, updatedAt: new Date() })
			.where(and(eq(financeSubscriptions.id, id), eq(financeSubscriptions.userId, userId)))
			.returning({ id: financeSubscriptions.id }),
	);
	return updated.length > 0;
}

/** Removes a subscription; its documents go with it (ON DELETE cascade). */
export async function deleteSubscriptionRow(userId: string, id: string): Promise<void> {
	await onFinanceTables(() =>
		db()
			.delete(financeSubscriptions)
			.where(and(eq(financeSubscriptions.id, id), eq(financeSubscriptions.userId, userId))),
	);
}

/**
 * Records one document unless the same subscription already has one of that type from that message
 * (`finance_charges_dedupe_idx`) or the id exists. True when the row with this id is there afterwards,
 * so a resumed action still reports the document it recorded the first time.
 */
export async function insertDocument(values: ChargeInsert): Promise<boolean> {
	await onFinanceTables(() => db().insert(financeCharges).values(values).onConflictDoNothing());
	return (await documentRow(values.userId, values.id)) !== null;
}

export async function documentRow(userId: string, id: string): Promise<ChargeRow | null> {
	const [row] = await onFinanceTables(() =>
		db()
			.select()
			.from(financeCharges)
			.where(and(eq(financeCharges.id, id), eq(financeCharges.userId, userId)))
			.limit(1),
	);
	return row ?? null;
}

export async function deleteDocuments(userId: string, ids: readonly string[]): Promise<void> {
	if (ids.length === 0) return;
	await onFinanceTables(() =>
		db()
			.delete(financeCharges)
			.where(and(inArray(financeCharges.id, [...ids]), eq(financeCharges.userId, userId))),
	);
}

/** Documents of one subscription, newest first, or of all the owner's subscriptions. */
export function ownerDocuments(userId: string, subscriptionId?: string, limit?: number): Promise<ChargeRow[]> {
	const owner = eq(financeCharges.userId, userId);
	return onFinanceTables(() => {
		const query = db()
			.select()
			.from(financeCharges)
			.where(subscriptionId ? and(owner, eq(financeCharges.subscriptionId, subscriptionId)) : owner)
			.orderBy(desc(financeCharges.documentAt), desc(financeCharges.createdAt));
		return limit ? query.limit(limit) : query;
	});
}

/** Puts snapshotted rows back with their ids; rows that are already there are left alone. */
export async function restoreRows(
	subscription: SubscriptionRow | null,
	documents: readonly ChargeRow[],
): Promise<void> {
	if (subscription) await insertSubscription(subscription);
	for (const document of documents)
		await onFinanceTables(() => db().insert(financeCharges).values(document).onConflictDoNothing());
}
