import { daysBetween } from "./date-utils";
import { pairedDocumentIds, type LedgerEntry } from "./totals-utils";
import type { DocType } from "./types";

/** A row's status in the Payments list; `failed` only for a subscription's failed payment, which never counts. */
export type ListStatus = "open" | "paid" | "refunded" | "credited" | "failed";

/** One row of the Payments list: a payment found in mail, or a document in a tracked subscription's ledger. */
export type PaymentListEntry = {
	id: string;
	source: "payment" | "subscription";
	docType: DocType;
	/** The stored status of a payment row; for a ledger row it follows the type. */
	status: ListStatus;
	vendor: string;
	/** Pairs an invoice with its payment: the subscription's id for a ledger row, the vendor key otherwise. */
	group: string;
	amountMinor: number | null;
	currency: string | null;
	documentOn: string;
	/** A ledger document's stated period, which pairs it as the subscription view does; null for payment rows. */
	periodStartOn: string | null;
	/** A payment row's document number; null for ledger rows and documents without one. */
	docRef?: string | null;
	messageId: string | null;
	subscriptionId: string | null;
};

export type MonthTotal = {
	/** `YYYY-MM`. */
	month: string;
	currency: string;
	/** Payments and paid invoices. */
	paidMinor: number;
	/** Refunds and credits not settled by a refund. */
	refundedMinor: number;
	/** Invoices still open. */
	openMinor: number;
};

const LEDGER_STATUS: Record<DocType, ListStatus> = {
	invoice: "paid",
	payment: "paid",
	refund: "refunded",
	credit: "credited",
	failed_payment: "failed",
};

/** A ledger document's status: a subscription's invoice is charged with it, the rest follow their type. */
export function ledgerStatus(docType: DocType): ListStatus {
	return LEDGER_STATUS[docType];
}

/** Days after an invoice within which a failed payment of its subscription means it was not collected. */
const UNPAID_DAYS = 31;

/**
 * A subscription's invoices that a failed payment followed (same subscription, on or up to 31 days after the invoice)
 * and no payment settled: still open, not charged. Every other subscription invoice counts as charged with it.
 */
export function unpaidLedgerInvoices(entries: readonly PaymentListEntry[], paired: ReadonlySet<string>): Set<string> {
	const failures = entries.filter((entry) => entry.source === "subscription" && entry.docType === "failed_payment");
	const unpaid = new Set<string>();
	for (const entry of entries) {
		if (entry.source !== "subscription" || entry.docType !== "invoice" || paired.has(entry.id)) continue;
		const failed = failures.some(
			(failure) =>
				failure.group === entry.group &&
				failure.documentOn >= entry.documentOn &&
				daysBetween(entry.documentOn, failure.documentOn) <= UNPAID_DAYS,
		);
		if (failed) unpaid.add(entry.id);
	}
	return unpaid;
}

const asLedger = (entry: PaymentListEntry): LedgerEntry => ({
	id: entry.id,
	subscriptionId: entry.group,
	docType: entry.docType,
	amountMinor: entry.amountMinor,
	currency: entry.currency,
	documentOn: entry.documentOn,
	periodStartOn: entry.periodStartOn,
});

/**
 * The ids of invoices paid by a recorded payment and credits settled by a refund of the same vendor (or
 * subscription) and currency, which count once, through the money movement (spec §12.2 pairing).
 */
export function pairedEntryIds(entries: readonly PaymentListEntry[]): Set<string> {
	// An invoice and a payment naming the same number pair first, whatever their amounts and dates.
	const paired = new Set<string>();
	const settled = new Set<string>();
	for (const payment of entries) {
		if (payment.docType !== "payment" || !payment.docRef) continue;
		const invoice = entries.find(
			(entry) =>
				entry.docType === "invoice" &&
				!paired.has(entry.id) &&
				entry.group === payment.group &&
				entry.currency === payment.currency &&
				entry.docRef === payment.docRef,
		);
		if (!invoice) continue;
		paired.add(invoice.id);
		settled.add(payment.id);
	}
	const rest = entries.filter((entry) => !paired.has(entry.id) && !settled.has(entry.id));
	for (const id of pairedDocumentIds(rest.map(asLedger))) paired.add(id);
	return paired;
}

/** What a row shows: an invoice paired with a payment is paid, a credit paired with a refund is credited. */
export function shownStatus(entry: PaymentListEntry, paired: ReadonlySet<string>): ListStatus {
	if (paired.has(entry.id) && entry.docType === "invoice") return "paid";
	return entry.status;
}

type Bucket = Omit<MonthTotal, "month" | "currency">;

function bucketFor(entry: PaymentListEntry, paired: ReadonlySet<string>): Partial<Bucket> | null {
	if (entry.amountMinor === null || !entry.currency || paired.has(entry.id)) return null;
	const amount = entry.amountMinor;
	if (entry.status === "failed") return null;
	if (entry.docType === "invoice") return entry.status === "open" ? { openMinor: amount } : { paidMinor: amount };
	if (entry.docType === "payment") return { paidMinor: amount };
	return { refundedMinor: amount };
}

/**
 * Month totals per currency, never converted or summed across currencies (spec §25.6): paid (payments and paid
 * invoices), refunded (refunds and unsettled credits) and open (open invoices). A paired invoice or credit counts once,
 * through its payment or refund. Newest month first, then by currency code.
 */
export function monthTotals(entries: readonly PaymentListEntry[], paired = pairedEntryIds(entries)): MonthTotal[] {
	const totals = new Map<string, MonthTotal>();
	for (const entry of entries) {
		const bucket = bucketFor(entry, paired);
		if (!bucket) continue;
		const month = entry.documentOn.slice(0, 7);
		const key = `${month} ${entry.currency}`;
		const total = totals.get(key) ?? { month, currency: entry.currency!, paidMinor: 0, refundedMinor: 0, openMinor: 0 };
		total.paidMinor += bucket.paidMinor ?? 0;
		total.refundedMinor += bucket.refundedMinor ?? 0;
		total.openMinor += bucket.openMinor ?? 0;
		totals.set(key, total);
	}
	return [...totals.values()].sort((a, b) =>
		a.month !== b.month ? (a.month < b.month ? 1 : -1) : a.currency < b.currency ? -1 : 1,
	);
}

/** Newest first, then payments before the documents they settle, then by id for a stable order. */
export function sortEntries(entries: readonly PaymentListEntry[]): PaymentListEntry[] {
	return [...entries].sort((a, b) => {
		if (a.documentOn !== b.documentOn) return a.documentOn < b.documentOn ? 1 : -1;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});
}
