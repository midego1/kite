import type { EditableFields, PatchBody, SubscriptionBody } from "./api-schemas";
import type { CancelLink } from "./cancel-link-utils";
import { nextAfter, type Analysis } from "./detect-utils";
import { snapshotFields, type FieldKey, type SubscriptionFields, type SubscriptionRow } from "./record-utils";
import type { Cycle, TrackedMatchRow } from "./types";

export const NO_MAILBOX_ERROR = "Money Watch needs a mailbox you manage to record changes";

/** A mailbox the owner has full access to, with its creation time for the oldest-first rule. */
export type ManagedMailbox = { id: string; createdAt: Date | number | null };

const createdTime = (mailbox: ManagedMailbox) =>
	mailbox.createdAt instanceof Date ? mailbox.createdAt.getTime() : (mailbox.createdAt ?? 0);

/**
 * The mailbox an audit row for a change to a subscription names (spec §9.5): the row's own mailbox
 * while the owner still manages it, otherwise the oldest mailbox the owner manages, or null with none.
 */
export function auditMailbox(rowMailboxId: string | null, managed: readonly ManagedMailbox[]): string | null {
	if (rowMailboxId && managed.some((mailbox) => mailbox.id === rowMailboxId)) return rowMailboxId;
	const [oldest] = [...managed].sort((a, b) => createdTime(a) - createdTime(b) || a.id.localeCompare(b.id));
	return oldest?.id ?? null;
}

/** The fields of a subscription added by hand or from a message; the cancel link only ever comes from the message. */
export function manualFields(
	body: SubscriptionBody,
	source: { cancelLink: CancelLink | null; messageId: string | null },
): SubscriptionFields {
	const amountMinor = body.amountMinor ?? null;
	const trialEndsOn = body.trialEndsOn ?? null;
	return {
		vendor: body.vendor,
		plan: body.plan || null,
		amountMinor,
		currency: amountMinor === null ? null : (body.currency ?? null),
		cycle: body.cycle ?? null,
		nextRenewalOn: body.nextRenewalOn ?? null,
		renewalEstimated: false,
		trialEndsOn,
		status: body.status ?? (trialEndsOn ? "trial" : "active"),
		paymentFailedAt: null,
		reminderDays: body.reminderDays ?? 3,
		calendarReminder: body.calendarReminder ?? true,
		cancelUrl: source.cancelLink?.url ?? null,
		cancelOneClick: source.cancelLink?.oneClick ?? false,
		previousAmountMinor: null,
		priceChangedAt: null,
		lastMessageId: source.messageId,
	};
}

export type EditPlan = { capability: string; variant: string; input: Record<string, unknown> } | { error: string };

function fieldChanges(fields: EditableFields, row: SubscriptionRow): Partial<SubscriptionFields> | { error: string } {
	const changes: Partial<SubscriptionFields> = { ...fields };
	if (fields.plan !== undefined) changes.plan = fields.plan || null;
	if (fields.nextRenewalOn !== undefined) changes.renewalEstimated = false;
	if (fields.amountMinor === null) changes.currency = null;
	else if (fields.amountMinor !== undefined && fields.currency === undefined && !row.currency)
		return { error: "currency: An amount needs a currency" };
	if (fields.currency === null && fields.amountMinor === undefined && row.amountMinor !== null)
		return { error: "currency: An amount needs a currency" };
	return changes;
}

/** The action a `PATCH` body runs on a row: an edit, a reminder change or a status, with what undo restores. */
export function editPlan(body: PatchBody, row: SubscriptionRow): EditPlan {
	const subscriptionId = row.id;
	if ("status" in body)
		return {
			capability: "setSubscriptionStatus",
			variant: body.status,
			input: { variant: body.status, subscriptionId, previous: snapshotFields(row, ["status"]) },
		};
	let variant: "" | "reminder" = "reminder";
	let changes: Partial<SubscriptionFields>;
	if ("fields" in body) {
		const planned = fieldChanges(body.fields, row);
		if ("error" in planned) return planned;
		variant = "";
		changes = planned;
	} else {
		changes = {};
		if (body.reminderDays !== undefined) changes.reminderDays = body.reminderDays;
		if (body.calendarReminder !== undefined) changes.calendarReminder = body.calendarReminder;
	}
	const previous = snapshotFields(row, Object.keys(changes) as FieldKey[]);
	return { capability: "editSubscription", variant, input: { variant, subscriptionId, changes, previous } };
}

/** A document the dialogs offer to record, prefilled from the message. */
export type DocumentDraft = {
	docType: "invoice" | "payment" | "credit" | "refund";
	amountMinor: number;
	currency: string;
	documentOn: string;
	periodStartOn: string | null;
	periodEndOn: string | null;
	attachmentId: string | null;
};

/** What "Track as subscription" and "Add to a tracked subscription" open with; nothing of it is stored. */
export type ManualDraft = {
	vendor: string;
	vendorKey: string | null;
	plan: string | null;
	amountMinor: number | null;
	currency: string | null;
	cycle: Cycle | null;
	nextRenewalOn: string | null;
	renewalEstimated: boolean;
	trialEndsOn: string | null;
	cancelLink: CancelLink | null;
	document: DocumentDraft | null;
	/** The owner's tracked subscription the message matches, if any. */
	subscriptionId: string | null;
};

function documentDraft(analysis: Analysis): DocumentDraft | null {
	const { document, amount } = analysis;
	if (!document || document.docType === "failed_payment" || !amount) return null;
	return {
		docType: document.docType,
		amountMinor: amount.minor,
		currency: amount.currency,
		documentOn: document.documentOn,
		periodStartOn: document.periodStartOn,
		periodEndOn: document.periodEndOn,
		attachmentId: document.attachmentId,
	};
}

/**
 * The prefilled dialog fields for one message: what the detector read, the cycle the sender's earlier
 * mail or the matched row implies, and the renewal estimated from the cycle when the message names none.
 */
export function draftFromAnalysis(
	analysis: Analysis,
	context: { tracked: TrackedMatchRow | null; recurring: Cycle | null },
): ManualDraft {
	const cycle = analysis.cycle ?? context.recurring ?? context.tracked?.cycle ?? null;
	const estimated = !analysis.renewalOn && cycle !== null;
	return {
		vendor: analysis.vendor,
		vendorKey: analysis.vendorKey,
		plan: analysis.plan,
		amountMinor: analysis.amount?.minor ?? null,
		currency: analysis.amount?.currency ?? null,
		cycle,
		nextRenewalOn: analysis.renewalOn ?? (cycle ? nextAfter(analysis.dates.messageDay, cycle) : null),
		renewalEstimated: estimated,
		trialEndsOn: analysis.trialEndsOn,
		cancelLink: analysis.cancelLink,
		document: documentDraft(analysis),
		subscriptionId: context.tracked?.id ?? null,
	};
}
