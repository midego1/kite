import { z } from "zod";
import {
	answering,
	executeFinanceAction,
	managedMailboxes,
	noMailbox,
	notFound,
	ok,
	parseBody,
	type FinanceAnswer,
	type FinanceUser,
} from "./manual-context";
import { auditMailbox } from "./manual-utils";
import { paymentFieldsSchema } from "./payment-actions";
import { scanView, startScan } from "./payment-scan";
import { ownerPayment, type PaymentRow } from "./payments";
import { dateToDay } from "./record-utils";

const patchSchema = z.object({ fields: paymentFieldsSchema.refine((fields) => Object.keys(fields).length > 0) });

/** The row as `before`: what the action's undo puts back, the same on a resumed run. */
function beforeOf(row: PaymentRow) {
	return {
		id: row.id,
		vendor: row.vendor,
		amountMinor: row.amountMinor,
		currency: row.currency,
		documentAt: row.documentAt.toISOString(),
		docType: row.docType,
		status: row.status,
		removedAt: row.removedAt ? row.removedAt.toISOString() : null,
	};
}

function paymentView(row: PaymentRow) {
	return {
		id: row.id,
		vendor: row.vendor,
		docType: row.docType,
		status: row.status,
		amount: { minor: row.amountMinor, currency: row.currency },
		documentOn: dateToDay(row.documentAt),
		messageId: row.messageId,
	};
}

/** The owner's live payment and the mailbox its audit row names (spec §9.5), or the answer that stops the change. */
async function paymentForChange(
	user: FinanceUser,
	id: string,
): Promise<{ answer: FinanceAnswer } | { row: PaymentRow; mailboxId: string; answer: undefined }> {
	const row = await ownerPayment(user.id, id);
	if (!row || row.removedAt) return { answer: notFound() };
	const mailboxId = auditMailbox(row.mailboxId, await managedMailboxes(user));
	if (!mailboxId) return { answer: noMailbox() };
	return { row, mailboxId, answer: undefined };
}

/** `PATCH /api/finance/payments/[id]`: corrects a payment as `update_payment`; undo puts the old values back. */
export function patchPayment(user: FinanceUser, id: string, raw: unknown): Promise<FinanceAnswer> {
	return answering(async () => {
		const parsed = parseBody(patchSchema, raw);
		if ("answer" in parsed) return parsed.answer;
		const target = await paymentForChange(user, id);
		if (target.answer) return target.answer;
		const executed = await executeFinanceAction(user, {
			capability: "updatePayment",
			mailboxId: target.mailboxId,
			input: { paymentId: target.row.id, fields: parsed.data.fields },
			before: beforeOf(target.row),
		});
		if ("answer" in executed) return executed.answer;
		const row = await ownerPayment(user.id, id);
		return ok({ payment: row ? paymentView(row) : null, actionId: executed.actionId });
	});
}

/** `DELETE /api/finance/payments/[id]`: removes a payment as `remove_payment`; undo shows it again. */
export function removePayment(user: FinanceUser, id: string): Promise<FinanceAnswer> {
	return answering(async () => {
		const target = await paymentForChange(user, id);
		if (target.answer) return target.answer;
		const executed = await executeFinanceAction(user, {
			capability: "removePayment",
			mailboxId: target.mailboxId,
			input: { paymentId: target.row.id },
			before: beforeOf(target.row),
		});
		if ("answer" in executed) return executed.answer;
		return ok({ actionId: executed.actionId });
	});
}

/** `POST /api/finance/payments/scan`: starts "Scan last 90 days" (or reports the running one). */
export function startPaymentScan(user: FinanceUser): Promise<FinanceAnswer> {
	return answering(async () => ok({ scan: scanView(await startScan(user.id)) }));
}
