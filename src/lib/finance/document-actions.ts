import type { z } from "zod";
import { deleteDocumentInput, recordInput, type documentInputSchema } from "./action-input";
import { actionResult, financeAction, priorRow, requireRow } from "./action-runner";
import { FinanceRefusal } from "./errors";
import { dayToDate, derivedId, fieldColumns, rowJson, snapshotFields } from "./record-utils";
import { deleteDocuments, documentRow, insertDocument, updateSubscription } from "./subscriptions";

type DocumentInput = z.infer<typeof documentInputSchema>;

/**
 * Records one ledger document for an action, with an id derived from the action. False when the
 * subscription already had a document of that type from that message, which is then left alone.
 */
export async function recordLedgerDocument(input: {
	userId: string;
	subscriptionId: string;
	actionId: string;
	messageId: string | null;
	document: DocumentInput;
}): Promise<{ id: string; recorded: boolean }> {
	const id = derivedId("fdoc", input.actionId);
	const { document } = input;
	const recorded = await insertDocument({
		id,
		subscriptionId: input.subscriptionId,
		userId: input.userId,
		messageId: input.messageId,
		attachmentId: input.messageId ? document.attachmentId : null,
		docType: document.docType,
		amountMinor: document.amountMinor,
		currency: document.amountMinor === null ? null : document.currency,
		documentAt: dayToDate(document.documentOn)!,
		periodStartAt: dayToDate(document.periodStartOn),
		periodEndAt: dayToDate(document.periodEndOn),
		createdAt: new Date(),
	});
	return { id, recorded };
}

/**
 * `record_document`: one invoice, payment, credit note or refund on a tracked subscription. Nothing
 * else about the subscription changes, except that a payment clears a failed payment.
 */
export const recordDocument = financeAction(recordInput, async ({ actionId, userId, input, before }) => {
	const row = await requireRow(userId, input.subscriptionId);
	const prior = priorRow(before, userId, row);
	const { id, recorded } = await recordLedgerDocument({
		userId,
		subscriptionId: row.id,
		actionId,
		messageId: input.messageId,
		document: input.document,
	});
	const clears = input.variant === "payment" && (prior ?? row).paymentFailedAt !== null;
	const earlier = prior ? snapshotFields(prior, ["paymentFailedAt"]) : input.previous;
	const previous = clears ? (earlier ?? snapshotFields(row, ["paymentFailedAt"])) : undefined;
	if (clears) await updateSubscription(userId, row.id, fieldColumns({ paymentFailedAt: null }));
	return {
		result: actionResult(row.id, { documentRecorded: recorded, documentId: recorded ? id : null }),
		inverse: { userId, subscriptionId: row.id, previous, documentIds: recorded ? [id] : [] },
	};
});

/** `delete_document`: removes one document; the snapshot in the inverse puts it back with its id. */
export const deleteDocument = financeAction(deleteDocumentInput, async ({ userId, input }) => {
	const document = await documentRow(userId, input.documentId);
	if (!document) throw new FinanceRefusal(409, "The document is no longer recorded");
	await deleteDocuments(userId, [document.id]);
	return {
		result: actionResult(document.subscriptionId, { documentId: document.id }),
		inverse: {
			userId,
			subscriptionId: document.subscriptionId,
			removed: { subscription: null, documents: [rowJson(document)] },
		},
	};
});
