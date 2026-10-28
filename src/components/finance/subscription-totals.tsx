"use client";

import type { CurrencyTotal } from "@/lib/finance/totals-utils";
import type { SubscriptionItem } from "./subscriptions-types";
import { costLines, paidLines, unpricedCount } from "./subscriptions-utils";
import { CARD_CLASS } from "@/components/ui/page-utils";

/** Monthly and yearly cost per currency (never converted) and what the ledger says was paid in 12 months. */
export function SubscriptionTotals({
	totals,
	items,
	locale,
}: {
	totals: CurrencyTotal[];
	items: SubscriptionItem[];
	locale: string;
}) {
	const costs = costLines(totals, locale);
	const paid = paidLines(
		totals.map((total) => ({ currency: total.currency, minor: total.paidLast12MonthsMinor })),
		locale,
	);
	const unpriced = unpricedCount(items);
	return (
		<section className={`grid gap-4 ${CARD_CLASS} p-5 sm:grid-cols-2`} data-finance-totals>
			<div className="min-w-0 space-y-1">
				<h2 className="text-xs font-medium text-neutral-500">Cost of active subscriptions</h2>
				{costs.length === 0 && <p className="text-sm text-neutral-600">Nothing with a price yet</p>}
				{costs.map((line) => (
					<div key={line.currency} data-finance-cost={line.currency}>
						<p className="text-sm text-neutral-900">
							<span className="font-semibold tabular-nums">{line.monthly}</span>
							<span className="text-neutral-500"> · </span>
							<span className="tabular-nums">{line.yearly}</span>
						</p>
						{line.trial && <p className="text-xs text-neutral-500">{line.trial}</p>}
					</div>
				))}
				{unpriced > 0 && (
					<p className="text-xs text-neutral-500" data-finance-unpriced>
						{unpriced} without a price
					</p>
				)}
			</div>
			<div className="min-w-0 space-y-1">
				<h2 className="text-xs font-medium text-neutral-500">Paid in the last 12 months</h2>
				{paid.length === 0 && <p className="text-sm text-neutral-600">Nothing recorded yet</p>}
				{paid.map((line) => (
					<p
						key={line.currency}
						className="text-sm font-semibold tabular-nums text-neutral-900"
						data-finance-paid={line.currency}
					>
						{line.text}
					</p>
				))}
			</div>
		</section>
	);
}
