import { daysBetween } from "./date-utils";
import { dateToDay, subscriptionHref, webhookSubscription, type SubscriptionRow } from "./record-utils";
import { priceText } from "./text-utils";

const DAY_MS = 86_400_000;

/** The calendar event is at this time on the due date, in the owner's time zone (spec §11). */
const EVENT_TIME = "09:00";
const EVENT_MINUTES = 15;

export type ReminderRow = Pick<
	SubscriptionRow,
	| "id"
	| "vendor"
	| "plan"
	| "amountMinor"
	| "currency"
	| "cycle"
	| "status"
	| "nextRenewalAt"
	| "trialEndsAt"
	| "reminderDays"
	| "calendarReminder"
	| "lastRemindedFor"
	| "calendarEventId"
	| "sourceMessageId"
>;

export type Due = { on: string; at: Date; kind: "renewal" | "trial_end" };

export type ReminderStep =
	{ step: "wait" } | { step: "silent"; due: Due } | { step: "remind"; due: Due; daysLeft: number };

const reminds = (row: Pick<ReminderRow, "status" | "reminderDays">) =>
	(row.status === "active" || row.status === "trial") && row.reminderDays > 0;

/** The day a reminder is about: the trial end for a trial that has one, otherwise the next renewal. */
export function dueOf(row: Pick<ReminderRow, "status" | "nextRenewalAt" | "trialEndsAt">): Due | null {
	if (row.status === "trial" && row.trialEndsAt)
		return { on: dateToDay(row.trialEndsAt)!, at: row.trialEndsAt, kind: "trial_end" };
	return row.nextRenewalAt ? { on: dateToDay(row.nextRenewalAt)!, at: row.nextRenewalAt, kind: "renewal" } : null;
}

const remindedFor = (row: Pick<ReminderRow, "lastRemindedFor">, due: Due) =>
	row.lastRemindedFor?.getTime() === due.at.getTime();

/**
 * What a tick does with a row on the owner's calendar day `today`: nothing yet, claim it without a
 * notice (its due date passed while it was not reminded), or remind.
 */
export function reminderStep(row: ReminderRow, today: string): ReminderStep {
	const due = dueOf(row);
	if (!due || !reminds(row) || remindedFor(row, due)) return { step: "wait" };
	const daysLeft = daysBetween(today, due.on);
	if (daysLeft > row.reminderDays) return { step: "wait" };
	return daysLeft < 0 ? { step: "silent", due } : { step: "remind", due, daysLeft };
}

function whenText(daysLeft: number): string {
	if (daysLeft === 0) return "today";
	if (daysLeft === 1) return "tomorrow";
	return `in ${daysLeft} days`;
}

const amountOf = (row: ReminderRow, locale: string) => priceText({ ...row, cycle: null }, locale);

/** "Netflix renews in 3 days ($17.99)" or "Your Netflix trial ends tomorrow", linking to the row. */
export function reminderNotice(row: ReminderRow, due: Due, daysLeft: number, locale: string) {
	const amount = amountOf(row, locale);
	const title =
		due.kind === "trial_end"
			? `Your ${row.vendor} trial ends ${whenText(daysLeft)}`
			: `${row.vendor} renews ${whenText(daysLeft)}${amount ? ` (${amount})` : ""}`;
	return { notice: "renewal_due", title, href: subscriptionHref(row.id) };
}

export const reminderKey = (subscriptionId: string) => `finance-renewal:${subscriptionId}`;

/** The Calendar `upsertReminder` input for the row, without the user. */
export function reminderEvent(row: ReminderRow, due: Due, timeZone: string) {
	const amount = amountOf(row, "en");
	const title =
		due.kind === "trial_end" ? `${row.vendor} trial ends` : `${row.vendor} renews${amount ? ` (${amount})` : ""}`;
	return {
		key: reminderKey(row.id),
		title,
		description: `Open in Money Watch: ${subscriptionHref(row.id)}`,
		date: due.on,
		time: EVENT_TIME,
		durationMinutes: EVENT_MINUTES,
		timeZone,
		sourceMessageId: row.sourceMessageId,
	};
}

/** The `finance.subscription.renewal_due` payload. */
export function renewalDuePayload(row: ReminderRow, due: Due, daysLeft: number) {
	return {
		subscription: webhookSubscription(row),
		due: { on: due.on, kind: due.kind, daysLeft },
	};
}

/**
 * What a change to a row means for its calendar event: remove it when the row is gone or can no
 * longer remind, keep it in step when it exists or the reminder already fired for this due date
 * (an undo puts it back without a second notice), and otherwise leave it to the cron.
 */
export function calendarSync(row: ReminderRow | null): "upsert" | "remove" | "none" {
	if (!row || !row.calendarReminder || !reminds(row)) return "remove";
	const due = dueOf(row);
	if (!due) return "remove";
	return row.calendarEventId || remindedFor(row, due) ? "upsert" : "none";
}

/**
 * The due dates a tick reads, before the per-owner check: from a day ago (a missed date in any time
 * zone) to a day past the reminder window, which the query adds per row.
 */
export function selectionBounds(now: Date): { from: Date; until: Date } {
	return { from: new Date(now.getTime() - DAY_MS), until: new Date(now.getTime() + DAY_MS) };
}
