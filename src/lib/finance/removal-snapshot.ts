import { storedInverse, type StoredInverse } from "./action-input";
import { FinanceRefusal } from "./errors";
import { rowJson, type ChargeRow, type SubscriptionRow } from "./record-utils";
import { ownerDocuments, SNAPSHOT_DOCUMENTS } from "./subscriptions";

type RemovalSnapshot = StoredInverse & { removed: NonNullable<StoredInverse["removed"]> };

/** The caller saves this in the pending action before any rows are removed. */
export async function subscriptionRemovalSnapshot(row: SubscriptionRow) {
	const documents = await ownerDocuments(row.userId, row.id, SNAPSHOT_DOCUMENTS + 1);
	if (documents.length > SNAPSHOT_DOCUMENTS)
		throw new FinanceRefusal(
			409,
			"This subscription has too many documents to remove in one step; remove older documents first",
		);
	return {
		userId: row.userId,
		subscriptionId: row.id,
		removed: { subscription: rowJson(row), documents: documents.map(rowJson) },
	};
}

export function documentRemovalSnapshot(document: ChargeRow) {
	return {
		userId: document.userId,
		subscriptionId: document.subscriptionId,
		removed: { subscription: null, documents: [rowJson(document)] },
	};
}

/** Refuse an unsnapshotted removal; on resume the live rows may already be gone. */
export function removalBefore(before: Record<string, unknown> | null, userId: string): RemovalSnapshot {
	const parsed = storedInverse.safeParse(before);
	if (!parsed.success || !parsed.data.removed) throw new FinanceRefusal(409, "The removal needs a saved undo snapshot");
	const { subscriptionId, removed } = parsed.data;
	if (
		parsed.data.userId !== userId ||
		(removed.subscription && (removed.subscription.id !== subscriptionId || removed.subscription.userId !== userId)) ||
		removed.documents.some((document) => document.userId !== userId || document.subscriptionId !== subscriptionId)
	)
		throw new FinanceRefusal(403, "Only the owner can change this subscription");
	return { ...parsed.data, removed };
}
