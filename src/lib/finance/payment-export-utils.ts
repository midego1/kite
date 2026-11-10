import type { PaymentFilter } from "./payment-filter-utils";

/** `money-watch-payments-2026-11.csv`: the filtered month when there is one, else the day of the export. */
export function exportFilename(filter: PaymentFilter, now: Date): string {
	const stamp = filter.month || now.toISOString().slice(0, 10);
	return `money-watch-payments-${stamp}.csv`;
}
