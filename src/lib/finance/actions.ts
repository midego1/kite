import { deleteSubscriptionInput, editInput, statusInput, trackInput } from "./action-input";
import { actionResult, financeAction, priorRow, requireRow } from "./action-runner";
import { TRACK_UPDATE_KEYS } from "./answer-utils";
import { FinanceRefusal } from "./errors";
import { recordLedgerDocument } from "./document-actions";
import { derivedId, fieldColumns, snapshotFields, suggestionSubscriptionId, type FieldKey } from "./record-utils";
import { removalBefore } from "./removal-snapshot";
import { deleteSubscriptionRow, insertSubscription, updateSubscription } from "./subscriptions";
import { emitSubscriptionDetected } from "./webhook-events";

/** Every change to a row's due date, status or reminder keeps its calendar event in step. */
const SYNCS_REMINDER = { syncsReminder: true };

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
 * `create_subscription`: `""` inserts a row (id derived from the card, or from the action when added
 * by hand) with its invoice or payment
 * document and tells the owner's webhooks once; `update` applies what a later card read to the row it
 * matched. Undo deletes the created row, or puts back the changed fields and removes only the
 * document this action inserted.
 */
export const trackSubscription = financeAction(
	trackInput,
	async ({ actionId, userId, ctx, suggestion, input, before }) => {
		if (input.variant === "update") {
			const row = await requireRow(userId, input.subscriptionId);
			const prior = priorRow(before, userId, row);
			const previous = prior ? snapshotFields(prior, TRACK_UPDATE_KEYS) : input.previous;
			await updateSubscription(userId, row.id, fieldColumns(input.changes));
			const recorded = await recordFor(userId, row.id, actionId, input.messageId, input.document);
			return {
				result: actionResult(row.id, { documentRecorded: recorded.documentRecorded }),
				inverse: { userId, subscriptionId: row.id, previous, documentIds: recorded.documentIds },
			};
		}
		const id =
			input.source === "suggestion" && suggestion.id
				? suggestionSubscriptionId(suggestion.id)
				: derivedId("fsub", actionId);
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
	},
	SYNCS_REMINDER,
);

/**
 * `update_subscription`: `""` edits the subscription's fields, `reminder` its reminder and
 * `payment_failed` marks a failed payment with its `failed_payment` document. Undo restores the
 * earlier values and removes the document.
 */
export const editSubscription = financeAction(
	editInput,
	async ({ actionId, userId, input, before }) => {
		const row = await requireRow(userId, input.subscriptionId);
		const keys = Object.keys(input.changes) as FieldKey[];
		const prior = priorRow(before, userId, row);
		const previous = prior ? snapshotFields(prior, keys) : (input.previous ?? snapshotFields(row, keys));
		await updateSubscription(userId, row.id, fieldColumns(input.changes));
		const recorded = await recordFor(userId, row.id, actionId, input.messageId ?? null, input.document);
		return {
			result: actionResult(row.id, { documentRecorded: recorded.documentRecorded }),
			inverse: { userId, subscriptionId: row.id, previous, documentIds: recorded.documentIds },
		};
	},
	SYNCS_REMINDER,
);

/** `set_subscription_status`: the variant is the new status; undo restores the earlier one. */
export const setSubscriptionStatus = financeAction(
	statusInput,
	async ({ userId, input }) => {
		const row = await requireRow(userId, input.subscriptionId);
		const previous = input.previous ?? snapshotFields(row, ["status"]);
		await updateSubscription(userId, row.id, { status: input.variant });
		return {
			result: actionResult(row.id, { status: input.variant }),
			inverse: { userId, subscriptionId: row.id, previous },
		};
	},
	SYNCS_REMINDER,
);

/**
 * `delete_subscription`: removes the row and its documents, keeping a snapshot so undo puts them back
 * with the same ids. A row with more than `SNAPSHOT_DOCUMENTS` documents is refused, since undo could
 * not restore the rest.
 */
export const deleteSubscription = financeAction(
	deleteSubscriptionInput,
	async ({ userId, input, before }) => {
		const inverse = removalBefore(before, userId);
		if (inverse.subscriptionId !== input.subscriptionId || !inverse.removed.subscription)
			throw new FinanceRefusal(409, "The removal snapshot does not match this subscription");
		await deleteSubscriptionRow(userId, input.subscriptionId);
		return {
			result: actionResult(input.subscriptionId),
			inverse,
		};
	},
	SYNCS_REMINDER,
);
