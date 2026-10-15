import { moduleHost } from "@/lib/modules/host";
import type { HostMessageDetail, HostSuggestion } from "@/lib/modules/host-types";
import type { CapabilityCallContext, CapabilityHandler, JsonValue } from "@/lib/modules/module-types";
import {
	documentInput,
	isAnswerOption,
	liveDocument,
	planAnswer,
	rowForPayload,
	trackedFields,
	trackUpdate,
	type AnswerOption,
	type AnswerPlan,
	type DocumentInput,
	type Refusal,
} from "./answer-utils";
import { refusalOf } from "./errors";
import { subscriptionSuggestion } from "./payload-schema";
import { rowJson, snapshotFields, subscriptionRef, type SubscriptionRow } from "./record-utils";
import { ownerRows } from "./subscriptions";
import type { SubscriptionPayload } from "./types";
import { senderAddress } from "./vendor-utils";

type AnswerInput = { suggestionId: string; option: string; deviceTimeZone: string | null };

type Card = {
	ctx: CapabilityCallContext;
	userId: string;
	suggestion: HostSuggestion;
	payload: SubscriptionPayload;
	message: HostMessageDetail;
	row: SubscriptionRow | null;
	document: DocumentInput | null;
};

const refused = (refusal: Refusal): JsonValue => ({ result: null, refused: refusal });

const LEDGER_ON_TRACK = new Set(["invoice", "payment"]);

/** The card's invoice or payment, which Track records; anything else is recorded through its own option. */
function trackDocument(document: DocumentInput | null): DocumentInput | null {
	return document && LEDGER_ON_TRACK.has(document.docType) ? document : null;
}

/** The failed-payment document Mark urgent records, dated by the card or else by the message. */
function failedPaymentDocument(card: Card): DocumentInput {
	if (card.document?.docType === "failed_payment") return card.document;
	return {
		docType: "failed_payment",
		documentOn: card.message.receivedAt.slice(0, 10),
		periodStartOn: null,
		periodEndOn: null,
		attachmentId: null,
		amountMinor: null,
		currency: null,
	};
}

async function contactId(card: Card): Promise<string | null> {
	const contact = await moduleHost.contacts.find(card.ctx, card.userId, senderAddress(card.message.from));
	return contact?.id ?? null;
}

type ActionCall = { input: Record<string, JsonValue> } | { refusal: Refusal };

const call = (input: object): ActionCall => ({ input: input as Record<string, JsonValue> });
const gone = (error: string): ActionCall => ({ refusal: { status: 409, error } });

async function actionInput(card: Card, plan: AnswerPlan): Promise<ActionCall> {
	const { payload, message, row } = card;
	const messageId = message.id;
	if (plan.capability === "trackSubscription" && plan.variant === "")
		return call({
			variant: "",
			fields: trackedFields(payload, messageId),
			vendorKey: payload.vendorKey,
			mailboxId: card.suggestion.mailboxId,
			contactId: await contactId(card),
			messageId,
			source: "suggestion",
			document: trackDocument(card.document),
		});
	if (!row) return gone("The subscription is no longer tracked");
	if (plan.capability === "trackSubscription") {
		const document = trackDocument(card.document);
		const update = trackUpdate(payload, row, document, messageId, new Date());
		return call({ variant: "update", subscriptionId: row.id, ...update, messageId, document });
	}
	if (plan.capability === "editSubscription")
		return call({
			variant: "payment_failed",
			subscriptionId: row.id,
			changes: { paymentFailedAt: new Date().toISOString() },
			previous: snapshotFields(row, ["paymentFailedAt"]),
			messageId,
			document: failedPaymentDocument(card),
		});
	if (!card.document) return gone("There is no credit or refund to record");
	return call({ variant: plan.variant, subscriptionId: row.id, messageId, document: card.document });
}

async function loadCard(ctx: CapabilityCallContext, userId: string, suggestionId: string): Promise<Card | Refusal> {
	const suggestion = await moduleHost.suggestions.get(ctx, "finance", suggestionId);
	if (!suggestion || suggestion.kind !== "subscription") return { status: 404, error: "Suggestion not found" };
	if (suggestion.status !== "open" && suggestion.status !== "accepted")
		return { status: 409, error: "This suggestion is no longer open" };
	const parsed = subscriptionSuggestion.safeParse(suggestion.payload);
	if (!parsed.success) return { status: 409, error: "This suggestion can no longer be answered" };
	const payload = parsed.data as SubscriptionPayload;
	const message = await moduleHost.mail.getMessage(ctx, suggestion.messageId);
	if (!message) return { status: 404, error: "Message not found" };
	const row = rowForPayload(await ownerRows(userId, payload.vendorKey), payload);
	const live = liveDocument(
		payload.document,
		message.attachments.map((attachment) => attachment.id),
	);
	return { ctx, userId, suggestion, payload, message, row, document: documentInput(payload, live) };
}

async function answer(ctx: CapabilityCallContext, userId: string, input: AnswerInput): Promise<JsonValue> {
	if (!isAnswerOption(input.option)) return refused({ status: 400, error: "Unknown option" });
	const option: AnswerOption = input.option;
	const card = await loadCard(ctx, userId, input.suggestionId);
	if ("status" in card) return refused(card);
	const plan = planAnswer(option, card.payload, card.row, { suggestionId: card.suggestion.id });
	if ("status" in plan) return refused(plan);
	const planned = await actionInput(card, plan);
	if ("refusal" in planned) return refused(planned.refusal);
	const executed = await moduleHost.actions.execute(ctx, "finance", {
		capability: plan.capability,
		mailboxId: card.suggestion.mailboxId,
		variant: plan.variant,
		suggestionId: card.suggestion.id,
		messageId: card.message.id,
		input: planned.input,
		before: card.row ? rowJson(card.row) : null,
	});
	if (!executed.ok) return refused({ status: executed.status, error: executed.error });
	await moduleHost.suggestions.decide(ctx, "finance", card.suggestion.id, "accepted");
	const result = (executed.result ?? {}) as { subscriptionId?: string; documentRecorded?: boolean | null };
	const subscriptionId = result.subscriptionId ?? card.row?.id;
	if (!subscriptionId) return refused({ status: 409, error: "The subscription is no longer tracked" });
	return {
		result: {
			status: "accepted",
			option,
			actionId: executed.actionId,
			subscription: subscriptionRef(subscriptionId),
			documentRecorded: result.documentRecorded ?? null,
		},
	};
}

/**
 * The `answerSubscription` service: the reviewer's click on a subscription card. It loads the card
 * only if the viewer may decide it, matches it again against the owner's rows (a row may have been
 * added since detection), drops an attachment reference the message no longer has, and runs one
 * action through the executor, so the write is audited, undoable and runs once on a double click.
 */
export const answerSubscription: CapabilityHandler = async (raw, ctx) => {
	if (!ctx.viewer) return refused({ status: 403, error: "Answering needs a signed-in user" });
	try {
		return await answer(ctx, ctx.viewer.userId, raw as AnswerInput);
	} catch (error) {
		const refusal = refusalOf(error);
		if (refusal) return refused(refusal);
		throw error;
	}
};
