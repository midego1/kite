import { PAYMENT_CATEGORIES } from "./category-utils";

/** The filter value that selects rows without a category. */
export const NO_CATEGORY = "none";

export const PAYMENT_STATUSES = ["open", "paid", "refunded", "credited", "failed"] as const;

/** The Payments tab's filters; an empty value filters nothing. The tab, its export and the tool read them alike. */
export type PaymentFilter = { vendor?: string; month?: string; status?: string; category?: string };

type Filterable = { vendor: string; documentOn: string; status: string; category: string | null };

/** Whether a row passes every filter named: the vendor exactly, the month as a `YYYY-MM` prefix, status, category. */
export function matchesPaymentFilter(item: Filterable, filter: PaymentFilter): boolean {
	return (
		(!filter.vendor || item.vendor === filter.vendor) &&
		(!filter.month || item.documentOn.startsWith(filter.month)) &&
		(!filter.status || item.status === filter.status) &&
		(!filter.category || (filter.category === NO_CATEGORY ? item.category === null : item.category === filter.category))
	);
}

/** The filter named by a query string, or why it cannot be read. Every value is checked; nothing is passed on raw. */
export function parsePaymentFilter(params: URLSearchParams): { filter: PaymentFilter } | { error: string } {
	const month = params.get("month") ?? "";
	if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return { error: "month: use YYYY-MM" };
	const status = params.get("status") ?? "";
	if (status && !(PAYMENT_STATUSES as readonly string[]).includes(status)) return { error: "status: not a status" };
	const category = params.get("category") ?? "";
	if (category && category !== NO_CATEGORY && !(PAYMENT_CATEGORIES as readonly string[]).includes(category))
		return { error: "category: not a category" };
	const vendor = params.get("vendor") ?? "";
	if (vendor.length > 200) return { error: "vendor: too long" };
	return { filter: { vendor, month, status, category } };
}
