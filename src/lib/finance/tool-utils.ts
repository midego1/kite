import { daysBetween } from "./date-utils";
import { dateToDay, subscriptionRef, type SubscriptionRow } from "./record-utils";
import type { CurrencyTotal } from "./totals-utils";
import type { SubscriptionStatus } from "./types";

export type ToolInput = {
	status?: SubscriptionStatus | "all";
	dueWithinDays?: number;
	limit: number;
};

type ToolRow = Pick<
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
	| "paymentFailedAt"
>;

const CURRENT: readonly SubscriptionStatus[] = ["active", "trial"];

/** The day something is due on an active or trial row: the trial end for a trial that has one, else the renewal. */
function dueOn(row: ToolRow): string | null {
	if (!CURRENT.includes(row.status)) return null;
	const trialEnd = row.status === "trial" ? dateToDay(row.trialEndsAt) : null;
	return trialEnd ?? dateToDay(row.nextRenewalAt);
}

function wanted(row: ToolRow, input: ToolInput, today: string): boolean {
	const statuses = input.status === "all" ? null : input.status ? [input.status] : CURRENT;
	if (statuses && !statuses.includes(row.status)) return false;
	if (input.dueWithinDays === undefined) return true;
	const due = dueOn(row);
	if (!due) return false;
	const daysLeft = daysBetween(today, due);
	return daysLeft >= 0 && daysLeft <= input.dueWithinDays;
}

const sortDay = (row: ToolRow) => dueOn(row) ?? dateToDay(row.nextRenewalAt) ?? "9999-12-31";

function byDueThenVendor(a: ToolRow, b: ToolRow): number {
	const due = sortDay(a).localeCompare(sortDay(b));
	if (due !== 0) return due;
	return a.vendor.localeCompare(b.vendor, "en", { sensitivity: "base" }) || a.id.localeCompare(b.id);
}

/**
 * The rows `list_subscriptions` answers with: active and trial rows unless a status (or "all") is named,
 * only those due within `dueWithinDays` days of `today` when it is set, soonest first, at most `limit`.
 */
export function selectToolRows<T extends ToolRow>(rows: readonly T[], input: ToolInput, today: string): T[] {
	return rows
		.filter((row) => wanted(row, input, today))
		.sort(byDueThenVendor)
		.slice(0, input.limit);
}

/** One subscription as the tool shows it. */
export function toolSubscription(row: ToolRow) {
	return {
		ref: subscriptionRef(row.id),
		vendor: row.vendor,
		plan: row.plan,
		amount: row.amountMinor !== null && row.currency ? { minor: row.amountMinor, currency: row.currency } : null,
		cycle: row.cycle,
		status: row.status,
		nextRenewalOn: dateToDay(row.nextRenewalAt),
		trialEndsOn: dateToDay(row.trialEndsAt),
		urgent: row.paymentFailedAt !== null,
	};
}

/** The per-currency totals the tool shows; the paid total may be negative and is never converted. */
export function toolTotals(totals: readonly CurrencyTotal[]) {
	return totals.map(({ currency, monthlyMinor, yearlyMinor, paidLast12MonthsMinor }) => ({
		currency,
		monthlyMinor,
		yearlyMinor,
		paidLast12MonthsMinor,
	}));
}
