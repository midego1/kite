import { addMonths, daysBetween } from "./date-utils";
import type { Cycle, DocType } from "./types";

/** One ledger row as the totals read it; dates are calendar days (`YYYY-MM-DD`). */
export type LedgerEntry = {
	id: string;
	subscriptionId: string;
	docType: DocType;
	amountMinor: number | null;
	currency: string | null;
	documentOn: string;
	periodStartOn: string | null;
};

export type PricedRow = {
	status: "active" | "trial" | "cancelled" | "expired";
	amountMinor: number | null;
	currency: string | null;
	cycle: Cycle | null;
};

export type CurrencyTotal = {
	currency: string;
	monthlyMinor: number;
	yearlyMinor: number;
	/** What trials add per month once they turn into paid subscriptions. */
	trialMonthlyMinor: number;
	paidLast12MonthsMinor: number;
};

/** Days apart within which an invoice and a payment of the same amount, without periods, are one charge. */
const PAIR_DAYS = 31;

const MONTHS_PER_CYCLE: Record<Cycle, number> = { weekly: 12 / 52, monthly: 1, quarterly: 3, yearly: 12 };

/** The monthly cost of one price, unrounded: weekly × 52 / 12, quarterly / 3, yearly / 12. @public Test-only: used inside this file, exported for tests. */
export function monthlyCost(amountMinor: number, cycle: Cycle): number {
	return amountMinor / MONTHS_PER_CYCLE[cycle];
}

/** The movement a document's request or promise pairs with: an invoice with a payment, a credit with a refund. */
const PAIRS: Partial<Record<DocType, DocType>> = { invoice: "payment", credit: "refund" };

function pairs(a: LedgerEntry, b: LedgerEntry): boolean {
	if (a.periodStartOn && b.periodStartOn) return a.periodStartOn === b.periodStartOn;
	return a.amountMinor === b.amountMinor && Math.abs(daysBetween(a.documentOn, b.documentOn)) <= PAIR_DAYS;
}

const byDateThenId = (a: LedgerEntry, b: LedgerEntry) =>
	a.documentOn === b.documentOn ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.documentOn < b.documentOn ? -1 : 1;

/**
 * Invoices paid by a payment and credits settled by a refund of the same subscription and currency,
 * which count once through the money movement. Each movement pairs with at most one document, the
 * nearest by date, ties to the older id.
 */
export function pairedDocumentIds(entries: readonly LedgerEntry[]): Set<string> {
	const paired = new Set<string>();
	const movements = entries.filter((entry) => entry.docType === "payment" || entry.docType === "refund");
	for (const movement of [...movements].sort(byDateThenId)) {
		const candidates = entries
			.filter(
				(entry) =>
					PAIRS[entry.docType] === movement.docType &&
					!paired.has(entry.id) &&
					entry.subscriptionId === movement.subscriptionId &&
					entry.currency === movement.currency &&
					pairs(entry, movement),
			)
			.sort((a, b) => {
				const distance =
					Math.abs(daysBetween(a.documentOn, movement.documentOn)) -
					Math.abs(daysBetween(b.documentOn, movement.documentOn));
				return distance !== 0 ? distance : a.id < b.id ? -1 : 1;
			});
		if (candidates[0]) paired.add(candidates[0].id);
	}
	return paired;
}

const SIGN: Record<DocType, number> = { invoice: 1, payment: 1, credit: -1, refund: -1, failed_payment: 0 };

/**
 * What was paid in the 12 months up to `today` (inclusive, from the same calendar date a year ago),
 * per currency: payments add, refunds subtract, unpaired invoices add and unsettled credits subtract;
 * failed payments never count. The result may be negative.
 */
export function paidLast12Months(entries: readonly LedgerEntry[], today: string): Map<string, number> {
	const paired = pairedDocumentIds(entries);
	const from = addMonths(today, -12);
	const totals = new Map<string, number>();
	for (const entry of entries) {
		if (entry.amountMinor === null || !entry.currency || paired.has(entry.id)) continue;
		if (entry.documentOn < from || entry.documentOn > today || SIGN[entry.docType] === 0) continue;
		totals.set(entry.currency, (totals.get(entry.currency) ?? 0) + SIGN[entry.docType] * entry.amountMinor);
	}
	return totals;
}

type Running = { monthly: number; trial: number };

/**
 * Monthly and yearly cost of active rows and what trials add, plus the 12-month paid total, one entry
 * per currency (never converted), sorted by currency code.
 */
export function currencyTotals(
	rows: readonly PricedRow[],
	entries: readonly LedgerEntry[],
	today: string,
): CurrencyTotal[] {
	const running = new Map<string, Running>();
	const at = (currency: string) => {
		const current = running.get(currency) ?? { monthly: 0, trial: 0 };
		running.set(currency, current);
		return current;
	};
	for (const row of rows) {
		if (row.amountMinor === null || !row.currency || !row.cycle) continue;
		if (row.status === "active") at(row.currency).monthly += monthlyCost(row.amountMinor, row.cycle);
		else if (row.status === "trial") at(row.currency).trial += monthlyCost(row.amountMinor, row.cycle);
	}
	const paid = paidLast12Months(entries, today);
	for (const currency of paid.keys()) at(currency);
	return [...running.entries()]
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.map(([currency, total]) => ({
			currency,
			monthlyMinor: Math.round(total.monthly),
			yearlyMinor: Math.round(total.monthly * 12),
			trialMonthlyMinor: Math.round(total.trial),
			paidLast12MonthsMinor: paid.get(currency) ?? 0,
		}));
}
