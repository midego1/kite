import { deleteSubscriptionInput, editInput, statusInput, trackInput } from "./action-input";
import { actionResult, financeAction, requireRow } from "./action-runner";
import { recordLedgerDocument } from "./document-actions";
import { derivedId, fieldColumns, rowJson, snapshotFields, type FieldKey } from "./record-utils";
import {
	SNAPSHOT_DOCUMENTS,
	deleteSubscriptionRow,
	insertSubscription,
	ownerDocuments,
	updateSubscription,
} from "./subscriptions";
import { emitSubscriptionDetected } from "./webhook-events";

type Recorded = { documentIds: string[]; documentRecorded: boolean | null };

async function recordFor(
	userId: string,
	subscriptionId: string,
	actionId: string,
	messageId: string | null,
	document: Parameters<typeof recordLedgerDocument>[0]["document"] | null | undefined,
): Promise<Recorded> {
	if (!document) return { documentIds: [], documentRecorded: null };
	const { id, recorded } = await recordLedgerDocument({ userId, subscriptionId, actionId, messageId, document });
	return { documentIds: recorded ? [id] : [], documentRecorded: recorded };
}

/**
 * `create_subscription`: `""` inserts a row (id derived from the action) with its invoice or payment
 * document and tells the owner's webhooks once; `update` applies what a later card read to the row it
 * matched. Undo deletes the created row, or puts back the changed fields and removes only the
 * document this action inserted.
 */
export const trackSubscription = financeAction(trackInput, async ({ actionId, userId, ctx, input }) => {
	if (input.variant === "update") {
		const row = await requireRow(userId, input.subscriptionId);
		await updateSubscription(userId, row.id, fieldColumns(input.changes));
		const recorded = await recordFor(userId, row.id, actionId, input.messageId, input.document);
		return {
			result: actionResult(row.id, { documentRecorded: recorded.documentRecorded }),
			inverse: { userId, subscriptionId: row.id, previous: input.previous, documentIds: recorded.documentIds },
		};
	}
	const id = derivedId("fsub", actionId);
	const now = new Date();
	const created = await insertSubscription({
		id,
		userId,
		mailboxId: input.mailboxId,
		contactId: input.contactId,
		vendorKey: input.vendorKey,
		sourceMessageId: input.messageId,
		...fieldColumns(input.fields),
		vendor: input.fields.vendor,
		createdAt: now,
		updatedAt: now,
	});
	const row = await requireRow(userId, id);
	const recorded = await recordFor(userId, id, actionId, input.messageId, input.document);
	if (created) await emitSubscriptionDetected(ctx, row, input.source, input.messageId);
	return {
		result: actionResult(id, { created, documentRecorded: recorded.documentRecorded }),
		inverse: { userId, subscriptionId: id, created: true },
	};
});

/**
 * `update_subscription`: `""` edits the subscription's fields, `reminder` its reminder and
 * `payment_failed` marks a failed payment with its `failed_payment` document. Undo restores the
 * earlier values and removes the document.
 */
export const editSubscription = financeAction(editInput, async ({ actionId, userId, input }) => {
	const row = await requireRow(userId, input.subscriptionId);
	const previous = input.previous ?? snapshotFields(row, Object.keys(input.changes) as FieldKey[]);
	await updateSubscription(userId, row.id, fieldColumns(input.changes));
	const recorded = await recordFor(userId, row.id, actionId, input.messageId ?? null, input.document);
	return {
		result: actionResult(row.id, { documentRecorded: recorded.documentRecorded }),
		inverse: { userId, subscriptionId: row.id, previous, documentIds: recorded.documentIds },
	};
});

/** `set_subscription_status`: the variant is the new status; undo restores the earlier one. */
export const setSubscriptionStatus = financeAction(statusInput, async ({ userId, input }) => {
	const row = await requireRow(userId, input.subscriptionId);
	const previous = input.previous ?? snapshotFields(row, ["status"]);
	await updateSubscription(userId, row.id, { status: input.variant });
	return {
		result: actionResult(row.id, { status: input.variant }),
		inverse: { userId, subscriptionId: row.id, previous },
	};
});

/**
 * `delete_subscription`: removes the row and its documents, keeping a snapshot (at most
 * `SNAPSHOT_DOCUMENTS` documents) so undo puts them back with the same ids.
 */
export const deleteSubscription = financeAction(deleteSubscriptionInput, async ({ userId, input }) => {
	const row = await requireRow(userId, input.subscriptionId);
	const documents = await ownerDocuments(userId, row.id, SNAPSHOT_DOCUMENTS);
	await deleteSubscriptionRow(userId, row.id);
	return {
		result: actionResult(row.id),
		inverse: {
			userId,
			subscriptionId: row.id,
			removed: { subscription: rowJson(row), documents: documents.map(rowJson) },
		},
	};
});
