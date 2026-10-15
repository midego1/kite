import { trackBody } from "./dialog-utils";
import type { TrackForm } from "./dialog-types";
import { formatDecimal, formatMoney } from "@/lib/finance/amount-utils";
import { addDays, daysBetween } from "@/lib/finance/date-utils";
import { priceText, shortDay } from "@/lib/finance/text-utils";
import type { CurrencyTotal } from "@/lib/finance/totals-utils";
import type { DocType, SubscriptionStatus } from "@/lib/finance/types";
import { isSameOriginPath } from "@/lib/modules/path-utils";
import type {
	AttentionEntry,
	DocumentItem,
	StatusFilter,
	SubscriptionGroups,
	SubscriptionItem,
} from "./subscriptions-types";

/** A price change is pointed out for this many days after it was recorded. */
const PRICE_CHIP_DAYS = 90;

const isCurrent = (item: SubscriptionItem) => item.status === "active" || item.status === "trial";

/** The day a row is about: the trial end for a trial that has one, otherwise the next renewal. */
function dueDayOf(item: Pick<SubscriptionItem, "status" | "trialEndsOn" | "nextRenewalOn">): string | null {
	return item.status === "trial" && item.trialEndsOn ? item.trialEndsOn : item.nextRenewalOn;
}

/** "today", "tomorrow" or "in 5 days" for a day on or after `today`; passed days are worded by the callers. */
function relativeDay(day: string, today: string): string {
	const days = daysBetween(today, day);
	if (days === 0) return "today";
	return days === 1 ? "tomorrow" : `in ${days} days`;
}

const isTrialEnd = (item: SubscriptionItem) => item.status === "trial" && item.trialEndsOn !== null;

function attentionReason(item: SubscriptionItem, today: string): string | null {
	if (item.urgent) return "Payment failed";
	const due = dueDayOf(item);
	if (!due) return null;
	const daysLeft = daysBetween(today, due);
	if (daysLeft < 0) return isTrialEnd(item) ? "Trial ended" : "Renewal date passed";
	if (isTrialEnd(item) && item.reminderDays > 0 && daysLeft <= item.reminderDays)
		return `Trial ends ${relativeDay(due, today)}`;
	return null;
}

const byVendor = (a: SubscriptionItem, b: SubscriptionItem) =>
	a.vendor.localeCompare(b.vendor, undefined, { sensitivity: "base" });

function byDue(a: SubscriptionItem, b: SubscriptionItem): number {
	const dueA = dueDayOf(a);
	const dueB = dueDayOf(b);
	if (dueA === dueB) return byVendor(a, b);
	if (!dueA || !dueB) return dueA ? -1 : 1;
	return dueA < dueB ? -1 : 1;
}

/**
 * The sections of the view: rows that need attention (failed payment, a trial ending within its
 * reminder window, a due date that passed), upcoming renewals by due date, current rows without a
 * date, and cancelled or expired rows. A row appears in one section only.
 */
export function groupSubscriptions(items: readonly SubscriptionItem[], today: string): SubscriptionGroups {
	const attention: AttentionEntry[] = [];
	const upcoming: SubscriptionItem[] = [];
	const noDate: SubscriptionItem[] = [];
	const ended: SubscriptionItem[] = [];
	for (const item of items) {
		if (!isCurrent(item)) {
			ended.push(item);
			continue;
		}
		const reason = attentionReason(item, today);
		if (reason) attention.push({ item, reason });
		else if (dueDayOf(item)) upcoming.push(item);
		else noDate.push(item);
	}
	return {
		attention: attention.sort((a, b) => byDue(a.item, b.item)),
		upcoming: upcoming.sort(byDue),
		noDate: noDate.sort(byVendor),
		ended: ended.sort(byVendor),
	};
}

/** "renews in 5 days (1 Nov)", "trial ends tomorrow (16 Oct)" or "was due 1 Oct"; null without a date. */
export function dueText(item: SubscriptionItem, today: string): string | null {
	const due = dueDayOf(item);
	if (!due) return null;
	const trial = isTrialEnd(item);
	if (daysBetween(today, due) < 0) return trial ? `trial ended ${shortDay(due)}` : `was due ${shortDay(due)}`;
	return `${trial ? "trial ends" : "renews"} ${relativeDay(due, today)} (${shortDay(due)})`;
}

/** "Cancel before 31 Oct", the day before the due date; "Cancel" without one. */
export function cancelBeforeText(item: SubscriptionItem): string {
	const due = dueDayOf(item);
	return due ? `Cancel before ${shortDay(addDays(due, -1))}` : "Cancel";
}

/** "Increased from $17.99" or "Decreased from …" for 90 days after a price change, otherwise null. */
export function priceChangeChip(item: SubscriptionItem, today: string, locale: string): string | null {
	if (item.previousAmountMinor === null || !item.amount || !item.priceChangedAt) return null;
	if (daysBetween(item.priceChangedAt.slice(0, 10), today) > PRICE_CHIP_DAYS) return null;
	const previous = formatMoney(item.previousAmountMinor, item.amount.currency, locale);
	return `${item.amount.minor > item.previousAmountMinor ? "Increased" : "Decreased"} from ${previous}`;
}

/** "$17.99/month", "$17.99" without a cycle, "No price" without an amount. */
export function priceLabel(item: SubscriptionItem, locale: string): string {
	return (
		priceText(
			{ amountMinor: item.amount?.minor ?? null, currency: item.amount?.currency ?? null, cycle: item.cycle },
			locale,
		) ?? "No price"
	);
}

export type CostLine = { currency: string; monthly: string; yearly: string; trial: string | null };

/** The monthly and yearly cost per currency, with what trials add; currencies with no cost are left out. */
export function costLines(totals: readonly CurrencyTotal[], locale: string): CostLine[] {
	return totals
		.filter((total) => total.monthlyMinor !== 0 || total.trialMonthlyMinor !== 0)
		.map((total) => ({
			currency: total.currency,
			monthly: `${formatMoney(total.monthlyMinor, total.currency, locale)}/month`,
			yearly: `${formatMoney(total.yearlyMinor, total.currency, locale)}/year`,
			trial: total.trialMonthlyMinor
				? `after trials: +${formatMoney(total.trialMonthlyMinor, total.currency, locale)}/month`
				: null,
		}));
}

/** One line per currency with a non-zero paid total; a negative total is shown as it is. */
export function paidLines(
	totals: readonly { currency: string; minor: number }[],
	locale: string,
): { currency: string; text: string }[] {
	return totals
		.filter((total) => total.minor !== 0)
		.map((total) => ({ currency: total.currency, text: formatMoney(total.minor, total.currency, locale) }));
}

/** Current rows the cost totals cannot include, because they have no amount or no cycle. */
export function unpricedCount(items: readonly SubscriptionItem[]): number {
	return items.filter((item) => isCurrent(item) && (!item.amount || !item.cycle)).length;
}

const DOCUMENT_LABELS: Record<DocType, string> = {
	invoice: "Invoice",
	payment: "Payment",
	credit: "Credit note",
	refund: "Refund",
	failed_payment: "Payment failed",
};

export const documentLabel = (docType: DocType) => DOCUMENT_LABELS[docType];

/** The document's amount, with credits and refunds as "−$5.00"; null without one. */
export function documentAmount(document: Pick<DocumentItem, "docType" | "amount">, locale: string): string | null {
	if (!document.amount) return null;
	const text = formatMoney(document.amount.minor, document.amount.currency, locale);
	return document.docType === "credit" || document.docType === "refund" ? `−${text}` : text;
}

/** "Paid" for an invoice settled by a payment, "Refunded" for a credit settled by a refund. */
export function pairedLabel(document: Pick<DocumentItem, "docType" | "paired">): string | null {
	if (!document.paired) return null;
	return document.docType === "credit" ? "Refunded" : "Paid";
}

/** "1 Oct – 31 Oct", or null without a period. */
export function periodText(start: string | null, end: string | null): string | null {
	return start && end ? `${shortDay(start)} – ${shortDay(end)}` : null;
}

type LinkedDocument = Pick<DocumentItem, "messageId" | "attachmentId" | "message">;

/** The source message is gone, or the viewer can no longer read it. */
export const messageGone = (document: LinkedDocument) => !document.message || document.message.unavailable === true;

/** The conversation of the document's source message, when the viewer can still open it. */
export function threadHref(document: LinkedDocument): string | null {
	const message = document.message;
	if (!message || message.unavailable) return null;
	return message.href && isSameOriginPath(message.href) ? message.href : null;
}

/** The attachment through the normal attachment route, which checks the viewer's access itself. */
export function documentHref(document: LinkedDocument): string | null {
	if (messageGone(document) || !document.messageId || !document.attachmentId) return null;
	return `/api/messages/${encodeURIComponent(document.messageId)}/attachments/${encodeURIComponent(document.attachmentId)}?preview=1`;
}

/** The newest message the row was read from, for rows without a cancel link. */
export function latestMessageHref(item: SubscriptionItem): string | null {
	const id = item.lastMessageId ?? item.sourceMessageId;
	return id ? `/inbox/${encodeURIComponent(id)}` : null;
}

const STATUS_LABELS: Record<SubscriptionStatus, string> = {
	active: "Active",
	trial: "Trial",
	cancelled: "Cancelled",
	expired: "Expired",
};

export const statusLabel = (status: SubscriptionStatus) => STATUS_LABELS[status];

const STATUS_ORDER: readonly SubscriptionStatus[] = ["cancelled", "active", "expired", "trial"];

/** The status changes the row menu offers: every status but the current one. */
export function statusChoices(status: SubscriptionStatus): { status: SubscriptionStatus; label: string }[] {
	return STATUS_ORDER.filter((choice) => choice !== status).map((choice) => ({
		status: choice,
		label: `Mark as ${STATUS_LABELS[choice].toLowerCase()}`,
	}));
}

export const REMINDER_DAYS = [0, 1, 3, 7, 14] as const;

export function reminderLabel(days: number): string {
	if (days <= 0) return "Off";
	return days === 1 ? "1 day before" : `${days} days before`;
}

export function reminderToast(days: number): string {
	return days <= 0 ? "Reminder turned off" : `Reminder set to ${reminderLabel(days)}`;
}

/** The dialog's fields for an existing row. */
export function formFromItem(item: SubscriptionItem): TrackForm {
	return {
		vendor: item.vendor,
		plan: item.plan ?? "",
		amount: item.amount ? formatDecimal(item.amount.minor, item.amount.currency) : "",
		currency: item.amount?.currency ?? "",
		cycle: item.cycle ?? "",
		nextRenewalOn: item.nextRenewalOn ?? "",
		trialEndsOn: item.trialEndsOn ?? "",
		reminderDays: String(item.reminderDays),
		calendarReminder: item.calendarReminder,
	};
}

const EDITABLE = ["vendor", "plan", "amountMinor", "currency", "cycle", "nextRenewalOn", "trialEndsOn"] as const;

/** The `PATCH` body of the edit dialog with only the fields that changed, or the first problem to show. */
export function editChanges(
	form: TrackForm,
	item: SubscriptionItem,
): { fields: Record<string, unknown> } | { error: string } {
	const built = trackBody(form, null, null);
	if ("error" in built) return built;
	const current: Record<(typeof EDITABLE)[number], unknown> = {
		vendor: item.vendor,
		plan: item.plan,
		amountMinor: item.amount?.minor ?? null,
		currency: item.amount?.currency ?? null,
		cycle: item.cycle,
		nextRenewalOn: item.nextRenewalOn,
		trialEndsOn: item.trialEndsOn,
	};
	const fields: Record<string, unknown> = {};
	for (const key of EDITABLE) if (built.body[key] !== current[key]) fields[key] = built.body[key];
	return { fields };
}

/** The `POST /api/finance/subscriptions` body of a row added by hand, or the first problem to show. */
export function addBody(form: TrackForm, mailboxId: string | null) {
	const built = trackBody(form, null, null);
	if ("error" in built) return built;
	return { body: { ...built.body, mailboxId } };
}

/** Which sections the status filter shows. */
export function visibleSections(filter: StatusFilter): { current: boolean; ended: boolean } {
	return { current: filter !== "ended", ended: filter !== "current" };
}
