import { and, desc, eq, inArray, notExists, notInArray } from "drizzle-orm";
import { getDb } from "@/db";
import { queryInChunks } from "@/db/chunk-utils";
import { contacts, mailboxes, messages } from "@/db/schema";
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

/** Whether the subscription already has a document of this type from this message (`finance_charges_dedupe_idx`). */
export async function hasDocument(
	userId: string,
	subscriptionId: string,
	messageId: string,
	docType: ChargeRow["docType"],
): Promise<boolean> {
	const [row] = await onFinanceTables(() =>
		db()
			.select({ id: financeCharges.id })
			.from(financeCharges)
			.where(
				and(
					eq(financeCharges.userId, userId),
					eq(financeCharges.subscriptionId, subscriptionId),
					eq(financeCharges.messageId, messageId),
					eq(financeCharges.docType, docType),
				),
			)
			.limit(1),
	);
	return !!row;
}

/** The subscription's documents that are not among `ids`, whoever recorded them. */
function otherDocuments(subscriptionId: string, ids: readonly string[]) {
	const ofSubscription = eq(financeCharges.subscriptionId, subscriptionId);
	return db()
		.select({ id: financeCharges.id })
		.from(financeCharges)
		.where(ids.length > 0 ? and(ofSubscription, notInArray(financeCharges.id, [...ids])) : ofSubscription);
}

/** Whether the subscription holds a document that is not among `ids`. */
export async function hasOtherDocument(subscriptionId: string, ids: readonly string[]): Promise<boolean> {
	const rows = await onFinanceTables(() => otherDocuments(subscriptionId, ids).limit(1));
	return rows.length > 0;
}

/**
 * Deletes a subscription unless it holds a document that is not among `own`, checked in the same
 * statement so a document recorded meanwhile is never deleted with it. False when such a document
 * kept the row; true when the row is gone, including when an earlier call already deleted it.
 */
export async function deleteSubscriptionWithOnly(userId: string, id: string, own: readonly string[]): Promise<boolean> {
	const deleted = await onFinanceTables(() =>
		db()
			.delete(financeSubscriptions)
			.where(
				and(
					eq(financeSubscriptions.id, id),
					eq(financeSubscriptions.userId, userId),
					notExists(otherDocuments(id, own)),
				),
			)
			.returning({ id: financeSubscriptions.id }),
	);
	return deleted.length > 0 || !(await ownerRow(userId, id));
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

type LinkTable = typeof messages | typeof contacts | typeof mailboxes;

/** The ids among `ids` that still have a row in `table`. */
async function liveIds(table: LinkTable, ids: readonly (string | null)[]): Promise<Set<string>> {
	const wanted = [...new Set(ids.filter((id): id is string => !!id))];
	const found = await queryInChunks(wanted, (chunk) =>
		db().select({ id: table.id }).from(table).where(inArray(table.id, chunk)),
	);
	return new Set(found.map((row) => row.id));
}

const keepLive = (id: string | null, live: Set<string>) => (id && live.has(id) ? id : null);

/**
 * Puts snapshotted rows back with their ids; rows that are already there are left alone. A snapshot
 * outlives the `ON DELETE SET NULL` that cleared live rows when a message, contact or mailbox was
 * purged, so links to rows that are gone are cleared here instead of failing the foreign key.
 * `attachmentId` is not a foreign key and is ignored once the message link is null.
 */
export async function restoreRows(
	subscription: SubscriptionRow | null,
	documents: readonly ChargeRow[],
): Promise<void> {
	const liveMessages = await liveIds(messages, [
		subscription?.sourceMessageId ?? null,
		subscription?.lastMessageId ?? null,
		...documents.map((document) => document.messageId),
	]);
	if (subscription) {
		const [liveContacts, liveMailboxes] = await Promise.all([
			liveIds(contacts, [subscription.contactId]),
			liveIds(mailboxes, [subscription.mailboxId]),
		]);
		await insertSubscription({
			...subscription,
			sourceMessageId: keepLive(subscription.sourceMessageId, liveMessages),
			lastMessageId: keepLive(subscription.lastMessageId, liveMessages),
			contactId: keepLive(subscription.contactId, liveContacts),
			mailboxId: keepLive(subscription.mailboxId, liveMailboxes),
		});
	}
	for (const document of documents) {
		const values = { ...document, messageId: keepLive(document.messageId, liveMessages) };
		await onFinanceTables(() => db().insert(financeCharges).values(values).onConflictDoNothing());
	}
}
