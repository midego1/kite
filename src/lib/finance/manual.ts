import { moduleHost } from "@/lib/modules/host";
import type { HostMessageDetail } from "@/lib/modules/host-types";
import { patchBodySchema, subscriptionBodySchema, type DocumentBody, type SubscriptionBody } from "./api-schemas";
import { parseCancelLink } from "./cancel-link-utils";
import {
	answering,
	executeFinanceAction,
	fail,
	managedMailboxes,
	managedMessage,
	manages,
	noMailbox,
	notFound,
	ok,
	parseBody,
	sessionContext,
	todayFor,
	type FinanceAnswer,
	type FinanceUser,
} from "./manual-context";
import { auditMailbox, editPlan, manualFields, type ManagedMailbox } from "./manual-utils";
import { rowJson, subscriptionView, type SubscriptionRow } from "./record-utils";
import { subscriptionRemovalSnapshot } from "./removal-snapshot";
import { ownerRow } from "./subscriptions";
import { manualVendorKey, senderAddress, vendorKey, vendorName } from "./vendor-utils";

/** A document as an action records it, with every optional field explicit. */
export function documentInput(document: DocumentBody) {
	return {
		docType: document.docType,
		documentOn: document.documentOn,
		periodStartOn: document.periodStartOn ?? null,
		periodEndOn: document.periodEndOn ?? null,
		attachmentId: document.attachmentId ?? null,
		amountMinor: document.amountMinor,
		currency: document.currency,
	};
}

export const hasAttachment = (message: HostMessageDetail, attachmentId: string | null | undefined) =>
	!attachmentId || message.attachments.some((attachment) => attachment.id === attachmentId);

type Source = {
	mailboxId: string;
	messageId: string | null;
	vendorKey: string;
	contactId: string | null;
	cancelLink: ReturnType<typeof parseCancelLink>;
};

/**
 * Where a new row comes from. From a message: that message's mailbox (the user must manage it), the
 * sender's vendor key and contact, and the cancel link from its own `List-Unsubscribe`. By hand: the
 * mailbox chosen in the dialog, or the oldest one the user manages.
 */
async function sourceOf(
	user: FinanceUser,
	body: SubscriptionBody,
	managed: readonly ManagedMailbox[],
): Promise<Source | FinanceAnswer> {
	if (!body.messageId) {
		const mailboxId = body.mailboxId ?? auditMailbox(null, managed);
		if (!mailboxId) return noMailbox();
		if (!manages(managed, mailboxId)) return notFound("Mailbox not found");
		return { mailboxId, messageId: null, vendorKey: manualVendorKey(body.vendor), contactId: null, cancelLink: null };
	}
	const message = await managedMessage(user, managed, body.messageId);
	if (!message) return notFound("Message not found");
	if (!hasAttachment(message, body.document?.attachmentId)) return notFound("Attachment not found");
	const contact = await moduleHost.contacts.find(sessionContext(user), user.id, senderAddress(message.from));
	const sender = vendorName(message.fromName, message.from).vendor;
	return {
		mailboxId: message.mailboxId,
		messageId: message.id,
		vendorKey: vendorKey(message.from, sender) ?? manualVendorKey(body.vendor),
		contactId: contact?.id ?? null,
		cancelLink: parseCancelLink(
			message.headers?.["list-unsubscribe"] ?? null,
			message.headers?.["list-unsubscribe-post"] ?? null,
		),
	};
}

async function subscriptionAnswer(user: FinanceUser, id: string, actionId: string): Promise<FinanceAnswer> {
	const row = await ownerRow(user.id, id);
	return ok({ subscription: row ? subscriptionView(row) : null, actionId });
}

/** `POST /api/finance/subscriptions`: a subscription added by hand or from a message, as `create_subscription`. */
export function addSubscription(user: FinanceUser, raw: unknown): Promise<FinanceAnswer> {
	return answering(async () => {
		const parsed = parseBody(subscriptionBodySchema(todayFor(user)), raw);
		if ("answer" in parsed) return parsed.answer;
		const body = parsed.data;
		const managed = await managedMailboxes(user);
		if (managed.length === 0) return noMailbox();
		const source = await sourceOf(user, body, managed);
		if ("status" in source) return source;
		const executed = await executeFinanceAction(user, {
			capability: "trackSubscription",
			mailboxId: source.mailboxId,
			variant: "",
			messageId: source.messageId,
			input: {
				variant: "",
				fields: manualFields(body, source),
				vendorKey: source.vendorKey,
				mailboxId: source.mailboxId,
				contactId: source.contactId,
				messageId: source.messageId,
				source: "manual",
				document: body.document ? documentInput(body.document) : null,
			},
		});
		if ("answer" in executed) return executed.answer;
		const subscriptionId = String(executed.result.subscriptionId ?? "");
		const answer = await subscriptionAnswer(user, subscriptionId, executed.actionId);
		return { ...answer, body: { ...answer.body, documentRecorded: executed.result.documentRecorded ?? null } };
	});
}

/** The owner's row and the mailbox its audit rows name (spec §9.5), or the answer that stops the write. */
export async function rowForChange(
	user: FinanceUser,
	id: string,
): Promise<{ answer: FinanceAnswer } | { row: SubscriptionRow; mailboxId: string }> {
	const row = await ownerRow(user.id, id);
	if (!row) return { answer: notFound() };
	const mailboxId = auditMailbox(row.mailboxId, await managedMailboxes(user));
	if (!mailboxId) return { answer: noMailbox() };
	return { row, mailboxId };
}

/** `PATCH /api/finance/subscriptions/[id]`: an edit, a reminder change or a status change. */
export function changeSubscription(user: FinanceUser, id: string, raw: unknown): Promise<FinanceAnswer> {
	return answering(async () => {
		const target = await rowForChange(user, id);
		if ("answer" in target) return target.answer;
		const parsed = parseBody(patchBodySchema(todayFor(user)), raw);
		if ("answer" in parsed) return parsed.answer;
		const plan = editPlan(parsed.data, target.row);
		if ("error" in plan) return fail(400, plan.error);
		const executed = await executeFinanceAction(user, {
			capability: plan.capability,
			mailboxId: target.mailboxId,
			variant: plan.variant,
			input: plan.input,
			before: rowJson(target.row),
		});
		if ("answer" in executed) return executed.answer;
		return subscriptionAnswer(user, target.row.id, executed.actionId);
	});
}

/** `DELETE /api/finance/subscriptions/[id]`: removes the row and its documents, as `delete_subscription`. */
export function removeSubscription(user: FinanceUser, id: string): Promise<FinanceAnswer> {
	return answering(async () => {
		const target = await rowForChange(user, id);
		if ("answer" in target) return target.answer;
		const executed = await executeFinanceAction(user, {
			capability: "deleteSubscription",
			mailboxId: target.mailboxId,
			input: { subscriptionId: target.row.id },
			before: await subscriptionRemovalSnapshot(target.row),
		});
		if ("answer" in executed) return executed.answer;
		return ok({ actionId: executed.actionId });
	});
}
