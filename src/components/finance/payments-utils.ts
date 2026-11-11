import { formatDecimal, formatMoney } from "@/lib/finance/amount-utils";
import { paymentCategoryOf, type PaymentCategory } from "@/lib/finance/category-utils";
import { matchesPaymentFilter } from "@/lib/finance/payment-filter-utils";
import { msg } from "@/lib/i18n/translator";
import type { MessageKey, Translate } from "@/lib/i18n/i18n-types";
import { isSameOriginPath } from "@/lib/modules/path-utils";
import { parseAmountInput } from "./dialog-utils";
import type {
	MonthCurrencyTotal,
	PaymentDocType,
	PaymentFilters,
	PaymentForm,
	PaymentItem,
	PaymentListStatus,
	ScanCoverageGap,
	ScanState,
} from "./payments-types";

export const TYPE_LABELS: Record<PaymentDocType, MessageKey> = {
	invoice: msg("Invoice"),
	payment: msg("Payment"),
	credit: msg("Credit note"),
	refund: msg("Refund"),
	failed_payment: msg("Payment failed"),
};

export const STATUS_LABELS: Record<PaymentListStatus, MessageKey> = {
	open: msg("payment status|Open"),
	paid: msg("payment status|Paid"),
	refunded: msg("payment status|Refunded"),
	credited: msg("payment status|Credited"),
	failed: msg("payment status|Failed"),
};

export const CATEGORY_LABELS: Record<PaymentCategory, MessageKey> = {
	software: msg("category|Software and online services"),
	shopping: msg("category|Shopping"),
	food: msg("category|Food and drink"),
	travel: msg("category|Travel"),
	utilities: msg("category|Utilities and telecom"),
	health: msg("category|Health"),
	entertainment: msg("category|Entertainment"),
	education: msg("category|Education"),
	other: msg("category|Other"),
};

/** The categories in the order the pickers list them. */
export const CATEGORIES = Object.keys(CATEGORY_LABELS) as PaymentCategory[];

/** The statuses the filter offers, in the order of a payment's life. */
export const STATUS_FILTERS: readonly PaymentListStatus[] = ["open", "paid", "refunded", "credited", "failed"];

/** The amount as the row shows it: credits and refunds as "−€5.00"; null without one. */
export function amountText(item: Pick<PaymentItem, "docType" | "amount">, locale: string | undefined): string | null {
	if (!item.amount) return null;
	const text = formatMoney(item.amount.minor, item.amount.currency, locale ?? "en");
	return item.docType === "credit" || item.docType === "refund" ? `−${text}` : text;
}

/** "November 2026" for `2026-11`, in the interface language. */
export function monthLabel(month: string, locale: string | undefined): string {
	const [year, number] = month.split("-").map(Number);
	if (!year || !number) return month;
	return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(
		new Date(Date.UTC(year, number - 1, 1)),
	);
}

/** "3 Nov 2026" for a calendar day, in the interface language. */
export function dayLabel(day: string, locale: string | undefined): string {
	const date = new Date(`${day}T00:00:00.000Z`);
	if (Number.isNaN(date.getTime())) return day;
	return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(
		date,
	);
}

/** The vendors and months the filters offer: vendors by name, months newest first. */
export function filterOptions(items: readonly PaymentItem[]): { vendors: string[]; months: string[] } {
	const vendors = new Set<string>();
	const months = new Set<string>();
	for (const item of items) {
		if (item.vendor) vendors.add(item.vendor);
		months.add(item.documentOn.slice(0, 7));
	}
	return {
		vendors: [...vendors].sort((a, b) => a.localeCompare(b)),
		months: [...months].sort().reverse(),
	};
}

export function filterPayments(items: readonly PaymentItem[], filters: PaymentFilters): PaymentItem[] {
	return items.filter((item) => matchesPaymentFilter(item, filters));
}

/**
 * Where the CSV of the rows the filters show comes from (spec §27.4): the export route narrows by the same filters,
 * so the file holds what the list shows, without the list's 1,000-row cap.
 */
export function exportHref(filters: PaymentFilters): string {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
	const query = params.toString();
	return `/api/finance/payments/export${query ? `?${query}` : ""}`;
}

type Bucket = "paidMinor" | "refundedMinor" | "openMinor";

function bucketOf(item: PaymentItem): Bucket | null {
	if (!item.amount || item.paired || item.status === "failed") return null;
	if (item.docType === "invoice") return item.status === "open" ? "openMinor" : "paidMinor";
	if (item.docType === "payment") return "paidMinor";
	if (item.docType === "credit" || item.docType === "refund") return "refundedMinor";
	return null;
}

/**
 * Month totals per currency of the rows shown, never converted or added across currencies: paid, refunded and open.
 * A paired invoice or credit counts once, through its payment or refund. Newest month first, then by currency.
 */
export function monthTotals(items: readonly PaymentItem[]): MonthCurrencyTotal[] {
	const totals = new Map<string, MonthCurrencyTotal>();
	for (const item of items) {
		const bucket = bucketOf(item);
		if (!bucket || !item.amount) continue;
		const month = item.documentOn.slice(0, 7);
		const key = `${month} ${item.amount.currency}`;
		const total = totals.get(key) ?? {
			month,
			currency: item.amount.currency,
			paidMinor: 0,
			refundedMinor: 0,
			openMinor: 0,
		};
		total[bucket] += item.amount.minor;
		totals.set(key, total);
	}
	return [...totals.values()].sort((a, b) =>
		a.month !== b.month ? (a.month < b.month ? 1 : -1) : a.currency.localeCompare(b.currency),
	);
}

/** The totals grouped by month, for one block per month. */
export function totalsByMonth(totals: readonly MonthCurrencyTotal[]): { month: string; lines: MonthCurrencyTotal[] }[] {
	const months: { month: string; lines: MonthCurrencyTotal[] }[] = [];
	for (const total of totals) {
		const last = months[months.length - 1];
		if (last?.month === total.month) last.lines.push(total);
		else months.push({ month: total.month, lines: [total] });
	}
	return months;
}

/** The mail the row came from, when the viewer can still open it. */
export function mailHref(item: Pick<PaymentItem, "message">): string | null {
	const message = item.message;
	if (!message || message.unavailable) return null;
	return message.href && isSameOriginPath(message.href) ? message.href : null;
}

/** A payment row the viewer can correct: found in mail, not a subscription's document. */
export const editable = (item: Pick<PaymentItem, "source">) => item.source === "payment";

/** The Payments tab's scan status line: progress while running, the result once done, or Try again once failed. */
export function scanText(scan: ScanState, t: Translate): string {
	const values = { scanned: scan.scanned, recorded: scan.recorded, skipped: scan.skipped };
	if (scan.status === "running")
		return t(
			"Scanning the last 90 days: {scanned, plural, one {# message} other {# messages}} checked, {recorded, plural, =0 {no payments} one {# payment} other {# payments}} found so far",
			values,
		);
	if (scan.status === "failed") return t("Last scan could not finish. Try again.");
	if (scan.skipped)
		return t(
			"Last scan: {recorded, plural, =0 {no new payments} one {# new payment} other {# new payments}} in {scanned, plural, one {# message} other {# messages}}. {skipped, plural, one {# message} other {# messages}} could not be read.",
			values,
		);
	return t(
		"Last scan: {recorded, plural, =0 {no new payments} one {# new payment} other {# new payments}} in {scanned, plural, one {# message} other {# messages}}",
		values,
	);
}

/** One line per reason "Scan last 90 days" left mail out, so a fix that would not help one reason is never implied. */
const SCAN_COVERAGE_KEYS: Record<ScanCoverageGap["reason"], MessageKey> = {
	automatic_reading_off: msg(
		"{count, plural, one {# message} other {# messages}} in mailboxes without automatic reading were not scanned",
	),
	different_reviewer: msg(
		"{count, plural, one {# message} other {# messages}} are in mailboxes someone else reviews and were not scanned",
	),
	no_authentication: msg(
		"{count, plural, one {# message} other {# messages}} from connected accounts or imports have no authentication result and are not recorded yet",
	),
};

export function scanCoverageTexts(gaps: readonly ScanCoverageGap[], t: Translate): string[] {
	return gaps.map((gap) => t(SCAN_COVERAGE_KEYS[gap.reason], { count: gap.messages }));
}

/** The amount as the input shows it, with the currency's own decimals ("17.99", "1500"). */
function amountInput(item: Pick<PaymentItem, "amount">): string {
	return item.amount ? formatDecimal(item.amount.minor, item.amount.currency) : "";
}

export function formFromPayment(item: PaymentItem): PaymentForm {
	const docType = item.docType === "failed_payment" ? "payment" : item.docType;
	return {
		vendor: item.vendor,
		amount: amountInput(item),
		currency: item.amount?.currency ?? "",
		documentOn: item.documentOn,
		docType,
		status: item.storedStatus === "paid" ? "paid" : "open",
		category: paymentCategoryOf(item.category) ?? "",
	};
}

/** The fields a correction changes, or why it cannot be saved. */
export function correctionBody(
	form: PaymentForm,
	item: PaymentItem,
): { fields: Record<string, unknown> } | { error: MessageKey } {
	const currency = form.currency.trim().toUpperCase();
	if (!/^[A-Z]{3}$/.test(currency)) return { error: msg("Enter a three-letter currency code, such as EUR") };
	const amountMinor = parseAmountInput(form.amount, currency);
	if (amountMinor === null) return { error: msg("Enter an amount above zero") };
	const vendor = form.vendor.trim();
	if (!vendor) return { error: msg("Enter who the payment was to or from") };
	if (!/^\d{4}-\d{2}-\d{2}$/.test(form.documentOn)) return { error: msg("Enter a date") };
	const fields: Record<string, unknown> = {};
	if (vendor !== item.vendor) fields.vendor = vendor;
	if (amountMinor !== item.amount?.minor) fields.amountMinor = amountMinor;
	if (currency !== item.amount?.currency) fields.currency = currency;
	if (form.documentOn !== item.documentOn) fields.documentOn = form.documentOn;
	if (form.docType !== item.docType) fields.docType = form.docType;
	if (form.docType === "invoice" && form.status !== item.storedStatus) fields.status = form.status;
	if (form.category !== (item.category ?? "")) fields.category = form.category || null;
	return { fields };
}

/** Whether any filter narrows the list. */
export function anyFilter(filters: PaymentFilters): boolean {
	return Boolean(filters.vendor || filters.month || filters.status || filters.category);
}
