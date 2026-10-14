import { matchTracked } from "./detect-utils";
import { snapshotFields, type FieldKey, type SubscriptionFields, type SubscriptionRow } from "./record-utils";
import type { DocumentInfo } from "./document-utils";
import type { SubscriptionEvent, SubscriptionPayload } from "./types";

export type AnswerOption = "track" | "record" | "mark_urgent";

/** A refusal the answer service and the actions return instead of throwing. */
export type Refusal = { status: 400 | 403 | 404 | 409; error: string };

const OPTION_EVENTS: Record<AnswerOption, readonly SubscriptionEvent[]> = {
	track: ["new", "trial", "renewal", "price_change"],
	record: ["refund"],
	mark_urgent: ["payment_failed"],
};

export function isAnswerOption(value: string): value is AnswerOption {
	return Object.hasOwn(OPTION_EVENTS, value);
}

/** Whether the button a card offers fits its event: Track or Update, Record it, or Mark urgent. @public Test-only: used inside this file, exported for tests. */
export function optionFits(option: AnswerOption, event: SubscriptionEvent): boolean {
	return OPTION_EVENTS[option].includes(event);
}

/**
 * The owner's row a card is about now: the one it names if it still exists, otherwise the best match
 * by vendor key, currency, plan and amount, since the row may have been added after detection.
 */
export function rowForPayload(rows: readonly SubscriptionRow[], payload: SubscriptionPayload): SubscriptionRow | null {
	const named = payload.subscriptionId ? rows.find((row) => row.id === payload.subscriptionId) : undefined;
	if (named) return named;
	const amount =
		payload.amountMinor !== null && payload.currency
			? { minor: payload.amountMinor, currency: payload.currency }
			: null;
	return matchTracked(rows, { vendorKey: payload.vendorKey, plan: payload.plan, amount });
}

/** The card's document, without an attachment reference that is no longer an attachment of the message. */
export function liveDocument(document: DocumentInfo | null, attachmentIds: readonly string[]): DocumentInfo | null {
	if (!document?.attachmentId || attachmentIds.includes(document.attachmentId)) return document;
	return { ...document, attachmentId: null };
}

/** A ledger document as an action records it; the amount is always positive and the type gives the sign. */
export type DocumentInput = DocumentInfo & { amountMinor: number | null; currency: string | null };

export function documentInput(payload: SubscriptionPayload, document: DocumentInfo | null): DocumentInput | null {
	if (!document) return null;
	const needsAmount = document.docType !== "failed_payment";
	if (needsAmount && (payload.amountMinor === null || !payload.currency)) return null;
	return { ...document, amountMinor: payload.amountMinor, currency: payload.currency };
}

/** What Track on a matched row changes, and the earlier values undo puts back. */
export type FieldChange = { changes: Partial<SubscriptionFields>; previous: Partial<SubscriptionFields> };

function priceChanges(payload: SubscriptionPayload, row: SubscriptionRow, now: Date): Partial<SubscriptionFields> {
	if (payload.amountMinor === null || !payload.currency) return {};
	const changes: Partial<SubscriptionFields> = { amountMinor: payload.amountMinor, currency: payload.currency };
	if (row.amountMinor !== null && row.currency === payload.currency && row.amountMinor !== payload.amountMinor) {
		changes.previousAmountMinor = row.amountMinor;
		changes.priceChangedAt = now.toISOString();
	}
	return changes;
}

/**
 * The columns an accepted renewal, price change or trial card sets on the row it matches: the renewal
 * date, the amount (flagging a change in the same currency), the cycle, trial end and cancel link it
 * read, the message as the latest one; an invoice or payment moves a trial to active and a payment
 * clears a failed payment.
 */
export function trackUpdate(
	payload: SubscriptionPayload,
	row: SubscriptionRow,
	document: DocumentInfo | null,
	messageId: string,
	now: Date,
): FieldChange {
	const changes: Partial<SubscriptionFields> = { ...priceChanges(payload, row, now), lastMessageId: messageId };
	if (payload.nextRenewalOn) {
		changes.nextRenewalOn = payload.nextRenewalOn;
		changes.renewalEstimated = payload.renewalEstimated;
	}
	if (payload.cycle) changes.cycle = payload.cycle;
	if (payload.trialEndsOn) changes.trialEndsOn = payload.trialEndsOn;
	if (payload.cancelLink) {
		changes.cancelUrl = payload.cancelLink.url;
		changes.cancelOneClick = payload.cancelLink.oneClick;
	}
	const moneyMoved = document?.docType === "invoice" || document?.docType === "payment";
	if (moneyMoved && row.status === "trial") changes.status = "active";
	if (document?.docType === "payment") changes.paymentFailedAt = null;
	return { changes, previous: snapshotFields(row, Object.keys(changes) as FieldKey[]) };
}

/** The new row Track creates from a card. */
export function trackedFields(payload: SubscriptionPayload, messageId: string): SubscriptionFields {
	return {
		vendor: payload.vendor,
		plan: payload.plan,
		amountMinor: payload.amountMinor,
		currency: payload.amountMinor === null ? null : payload.currency,
		cycle: payload.cycle,
		nextRenewalOn: payload.nextRenewalOn,
		renewalEstimated: payload.nextRenewalOn ? payload.renewalEstimated : false,
		trialEndsOn: payload.trialEndsOn,
		status: payload.event === "trial" ? "trial" : "active",
		paymentFailedAt: null,
		reminderDays: 3,
		calendarReminder: true,
		cancelUrl: payload.cancelLink?.url ?? null,
		cancelOneClick: payload.cancelLink?.oneClick ?? false,
		previousAmountMinor: null,
		priceChangedAt: null,
		lastMessageId: messageId,
	};
}

export type AnswerPlan = { capability: string; variant: string };

/**
 * Which action an accept click runs. Track creates a row, or updates the matched one. A repeated click
 * on an accepted card whose message created the matched row is that same Track, so the executor hands
 * back the first action instead of running an update. Record and Mark urgent need the row to exist.
 */
export function planAnswer(
	option: AnswerOption,
	payload: SubscriptionPayload,
	row: SubscriptionRow | null,
	card: { messageId: string; repeat: boolean },
): AnswerPlan | Refusal {
	if (!optionFits(option, payload.event)) return { status: 400, error: "This option does not fit the suggestion" };
	if (option === "track") {
		const ownRow = card.repeat && row?.sourceMessageId === card.messageId;
		return { capability: "trackSubscription", variant: row && !ownRow ? "update" : "" };
	}
	if (!row) return { status: 409, error: "The subscription is no longer tracked" };
	if (option === "mark_urgent") return { capability: "editSubscription", variant: "payment_failed" };
	const docType = payload.document?.docType;
	if (docType !== "credit" && docType !== "refund")
		return { status: 409, error: "There is no credit or refund to record" };
	return { capability: "recordDocument", variant: docType };
}
