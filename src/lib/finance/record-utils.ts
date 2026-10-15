import { priceText } from "./text-utils";
import type { LedgerEntry } from "./totals-utils";
import type { Cycle, DocType, SubscriptionStatus } from "./types";

/** A `finance_subscriptions` row as Drizzle reads it. */
export type SubscriptionRow = {
	id: string;
	userId: string;
	mailboxId: string | null;
	contactId: string | null;
	vendor: string;
	vendorKey: string;
	plan: string | null;
	amountMinor: number | null;
	currency: string | null;
	cycle: Cycle | null;
	nextRenewalAt: Date | null;
	renewalEstimated: boolean;
	trialEndsAt: Date | null;
	status: SubscriptionStatus;
	paymentFailedAt: Date | null;
	reminderDays: number;
	calendarReminder: boolean;
	lastRemindedFor: Date | null;
	calendarEventId: string | null;
	cancelUrl: string | null;
	cancelOneClick: boolean;
	previousAmountMinor: number | null;
	priceChangedAt: Date | null;
	sourceMessageId: string | null;
	lastMessageId: string | null;
	createdAt: Date;
	updatedAt: Date;
};

/** A `finance_charges` row as Drizzle reads it. */
export type ChargeRow = {
	id: string;
	subscriptionId: string;
	userId: string;
	messageId: string | null;
	attachmentId: string | null;
	docType: DocType;
	amountMinor: number | null;
	currency: string | null;
	documentAt: Date;
	periodStartAt: Date | null;
	periodEndAt: Date | null;
	filedRef: string | null;
	createdAt: Date;
};

/**
 * The subscription columns an action can change, as JSON: calendar days for dates, ISO times for
 * instants. Actions store the changed keys and their earlier values, so undo can put them back.
 */
export type SubscriptionFields = {
	vendor: string;
	plan: string | null;
	amountMinor: number | null;
	currency: string | null;
	cycle: Cycle | null;
	nextRenewalOn: string | null;
	renewalEstimated: boolean;
	trialEndsOn: string | null;
	status: SubscriptionStatus;
	paymentFailedAt: string | null;
	reminderDays: number;
	calendarReminder: boolean;
	cancelUrl: string | null;
	cancelOneClick: boolean;
	previousAmountMinor: number | null;
	priceChangedAt: string | null;
	lastMessageId: string | null;
};

export type FieldKey = keyof SubscriptionFields;

/** 00:00 UTC of a calendar day, the way dates are stored. */
export function dayToDate(day: string | null): Date | null {
	return day ? new Date(`${day}T00:00:00.000Z`) : null;
}

/** @public Test-only: used inside this file, exported for tests. */
export function dateToDay(date: Date | null): string | null {
	return date ? date.toISOString().slice(0, 10) : null;
}

const isoOf = (date: Date | null) => (date ? date.toISOString() : null);
const dateOf = (iso: string | null) => (iso ? new Date(iso) : null);

/** The current values of `keys` on a row, for an action's undo. */
export function snapshotFields(row: SubscriptionRow, keys: readonly FieldKey[]): Partial<SubscriptionFields> {
	const all: SubscriptionFields = {
		vendor: row.vendor,
		plan: row.plan,
		amountMinor: row.amountMinor,
		currency: row.currency,
		cycle: row.cycle,
		nextRenewalOn: dateToDay(row.nextRenewalAt),
		renewalEstimated: row.renewalEstimated,
		trialEndsOn: dateToDay(row.trialEndsAt),
		status: row.status,
		paymentFailedAt: isoOf(row.paymentFailedAt),
		reminderDays: row.reminderDays,
		calendarReminder: row.calendarReminder,
		cancelUrl: row.cancelUrl,
		cancelOneClick: row.cancelOneClick,
		previousAmountMinor: row.previousAmountMinor,
		priceChangedAt: isoOf(row.priceChangedAt),
		lastMessageId: row.lastMessageId,
	};
	return Object.fromEntries(keys.map((key) => [key, all[key]])) as Partial<SubscriptionFields>;
}

type ColumnValues = Partial<Omit<SubscriptionRow, "id" | "userId" | "createdAt">>;

const DATE_KEYS: Partial<Record<FieldKey, keyof ColumnValues>> = {
	nextRenewalOn: "nextRenewalAt",
	trialEndsOn: "trialEndsAt",
};
const INSTANT_KEYS: Partial<Record<FieldKey, keyof ColumnValues>> = {
	paymentFailedAt: "paymentFailedAt",
	priceChangedAt: "priceChangedAt",
};

/** The Drizzle `set` for field values. */
export function fieldColumns(fields: Partial<SubscriptionFields>): ColumnValues {
	const columns: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(fields) as [FieldKey, unknown][]) {
		if (DATE_KEYS[key]) columns[DATE_KEYS[key]] = dayToDate(value as string | null);
		else if (INSTANT_KEYS[key]) columns[INSTANT_KEYS[key]] = dateOf(value as string | null);
		else columns[key] = value;
	}
	return columns as ColumnValues;
}

export const subscriptionRef = (id: string) => ({ kind: "finance:subscription" as const, id });

const money = (amountMinor: number | null, currency: string | null) =>
	amountMinor !== null && currency ? { minor: amountMinor, currency } : null;

/** A subscription as the API and tools show it. */
export function subscriptionView(row: SubscriptionRow) {
	return {
		id: row.id,
		ref: subscriptionRef(row.id),
		vendor: row.vendor,
		vendorKey: row.vendorKey,
		plan: row.plan,
		amount: money(row.amountMinor, row.currency),
		cycle: row.cycle,
		status: row.status,
		nextRenewalOn: dateToDay(row.nextRenewalAt),
		renewalEstimated: row.renewalEstimated,
		trialEndsOn: dateToDay(row.trialEndsAt),
		urgent: row.paymentFailedAt !== null,
		paymentFailedAt: isoOf(row.paymentFailedAt),
		reminderDays: row.reminderDays,
		calendarReminder: row.calendarReminder,
		cancelUrl: row.cancelUrl,
		cancelOneClick: row.cancelOneClick,
		previousAmountMinor: row.previousAmountMinor,
		priceChangedAt: isoOf(row.priceChangedAt),
		mailboxId: row.mailboxId,
		contactId: row.contactId,
		sourceMessageId: row.sourceMessageId,
		lastMessageId: row.lastMessageId,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

/** The `subscription` object of the Money Watch webhook payloads. */
export function webhookSubscription(
	row: Pick<
		SubscriptionRow,
		"id" | "vendor" | "plan" | "amountMinor" | "currency" | "cycle" | "status" | "nextRenewalAt" | "trialEndsAt"
	>,
) {
	return {
		ref: subscriptionRef(row.id),
		vendor: row.vendor,
		plan: row.plan,
		amount: money(row.amountMinor, row.currency),
		cycle: row.cycle,
		status: row.status,
		nextRenewalOn: dateToDay(row.nextRenewalAt),
		trialEndsOn: dateToDay(row.trialEndsAt),
	};
}

/** A ledger row in the form the totals read. */
export function ledgerEntry(row: ChargeRow): LedgerEntry {
	return {
		id: row.id,
		subscriptionId: row.subscriptionId,
		docType: row.docType,
		amountMinor: row.amountMinor,
		currency: row.currency,
		documentOn: dateToDay(row.documentAt)!,
		periodStartOn: dateToDay(row.periodStartAt),
	};
}

/** A ledger row as the API shows it; `paired` marks an invoice or credit that counts through its payment or refund. */
export function documentView(row: ChargeRow, paired: boolean) {
	return {
		id: row.id,
		subscriptionId: row.subscriptionId,
		docType: row.docType,
		amount: money(row.amountMinor, row.currency),
		documentOn: dateToDay(row.documentAt),
		periodStartOn: dateToDay(row.periodStartAt),
		periodEndOn: dateToDay(row.periodEndAt),
		messageId: row.messageId,
		attachmentId: row.messageId ? row.attachmentId : null,
		paired,
		createdAt: row.createdAt.toISOString(),
	};
}

/** "Netflix · $17.99/month", or the vendor alone without a price. */
export function subscriptionLabel(
	row: Pick<SubscriptionRow, "vendor" | "amountMinor" | "currency" | "cycle">,
	locale: string,
): string {
	const price = priceText(row, locale);
	return price ? `${row.vendor} · ${price}` : row.vendor;
}

const STATUSES: readonly SubscriptionStatus[] = ["active", "trial", "cancelled", "expired"];
const STATUS_GROUPS: Record<string, readonly SubscriptionStatus[]> = {
	current: ["active", "trial"],
	ended: ["cancelled", "expired"],
};

/** The statuses a `?status=` filter names: one status, `current`, `ended`, or anything else for all. */
export function statusesOf(filter: string | null): readonly SubscriptionStatus[] {
	if (filter && STATUS_GROUPS[filter]) return STATUS_GROUPS[filter];
	const one = STATUSES.find((status) => status === filter);
	return one ? [one] : STATUSES;
}

export const subscriptionHref = (id: string) => `/finance?subscription=${encodeURIComponent(id)}`;

const SUBSCRIPTION_DATES = [
	"nextRenewalAt",
	"trialEndsAt",
	"paymentFailedAt",
	"lastRemindedFor",
	"priceChangedAt",
	"createdAt",
	"updatedAt",
] as const;
const CHARGE_DATES = ["documentAt", "periodStartAt", "periodEndAt", "createdAt"] as const;

/** A row as JSON for an undo snapshot: instants become ISO strings. */
export function rowJson(row: SubscriptionRow | ChargeRow): Record<string, string | number | boolean | null> {
	return Object.fromEntries(
		Object.entries(row).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value]),
	);
}

function revive<T>(json: Record<string, unknown>, keys: readonly string[]): T {
	const row: Record<string, unknown> = { ...json };
	for (const key of keys) row[key] = typeof json[key] === "string" ? new Date(json[key] as string) : null;
	return row as T;
}

export const subscriptionFromJson = (json: Record<string, unknown>) =>
	revive<SubscriptionRow>(json, SUBSCRIPTION_DATES);

export const chargeFromJson = (json: Record<string, unknown>) => revive<ChargeRow>(json, CHARGE_DATES);

/** An id derived from the action that writes the row, so a resumed action finds what it already wrote. */
export function derivedId(prefix: "fsub" | "fdoc", actionId: string): string {
	return `${prefix}_${actionId.replace(/^aact_/, "")}`;
}

/** The id of the row Track creates from a card, the same for every click on that card. */
export function suggestionSubscriptionId(suggestionId: string): string {
	return `fsub_s_${suggestionId}`;
}
