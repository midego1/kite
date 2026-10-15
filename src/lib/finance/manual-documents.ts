import { documentBodySchema } from "./api-schemas";
import { documentInput, hasAttachment, rowForChange } from "./manual";
import {
	answering,
	executeFinanceAction,
	fail,
	managedMailboxes,
	managedMessage,
	notFound,
	ok,
	parseBody,
	todayFor,
	type FinanceAnswer,
	type FinanceUser,
} from "./manual-context";
import { documentView, rowJson } from "./record-utils";
import { documentRow, hasDocument } from "./subscriptions";

const documentExists = () => fail(409, "This document is already recorded for the subscription", "DOCUMENT_EXISTS");

/**
 * `POST /api/finance/subscriptions/[id]/documents`: one invoice, payment, credit note or refund from a
 * message the user manages, as `record_document`. Its audit row names the row's audit mailbox (spec
 * §9.5). The executor only accepts a message that lies in the action's mailbox, so the audit row names
 * the receipt only when it is in that mailbox; the ledger row always links it.
 */
export function addDocument(user: FinanceUser, subscriptionId: string, raw: unknown): Promise<FinanceAnswer> {
	return answering(async () => {
		const target = await rowForChange(user, subscriptionId);
		if ("answer" in target) return target.answer;
		const { row } = target;
		const parsed = parseBody(documentBodySchema(todayFor(user)), raw);
		if ("answer" in parsed) return parsed.answer;
		const body = parsed.data;
		const message = await managedMessage(user, await managedMailboxes(user), body.messageId);
		if (!message) return notFound("Message not found");
		if (!hasAttachment(message, body.attachmentId)) return notFound("Attachment not found");
		if (await hasDocument(user.id, row.id, message.id, body.docType)) return documentExists();
		const executed = await executeFinanceAction(user, {
			capability: "recordDocument",
			mailboxId: target.mailboxId,
			variant: body.docType,
			messageId: message.mailboxId === target.mailboxId ? message.id : null,
			input: { variant: body.docType, subscriptionId: row.id, messageId: message.id, document: documentInput(body) },
			before: rowJson(row),
		});
		if ("answer" in executed) return executed.answer;
		if (executed.result.documentRecorded === false) return documentExists();
		const recorded = await documentRow(user.id, String(executed.result.documentId ?? ""));
		return ok({ document: recorded ? documentView(recorded, false) : null, actionId: executed.actionId });
	});
}

/** `DELETE /api/finance/documents/[id]`: removes one document, as `delete_document`; undo puts it back. */
export function removeDocument(user: FinanceUser, documentId: string): Promise<FinanceAnswer> {
	return answering(async () => {
		const document = await documentRow(user.id, documentId);
		if (!document) return notFound();
		const target = await rowForChange(user, document.subscriptionId);
		if ("answer" in target) return target.answer;
		const executed = await executeFinanceAction(user, {
			capability: "deleteDocument",
			mailboxId: target.mailboxId,
			input: { documentId: document.id },
		});
		if ("answer" in executed) return executed.answer;
		return ok({ actionId: executed.actionId });
	});
}
