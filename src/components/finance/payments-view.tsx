"use client";

import { useState } from "react";
import toast from "react-hot-toast";
import { Receipt, ScanSearch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/page";
import { CARD_CLASS } from "@/components/ui/page-utils";
import { Select } from "@/components/ui/select";
import { formatMoney } from "@/lib/finance/amount-utils";
import { currentLocale } from "@/lib/i18n/translator";
import { useT } from "@/lib/i18n/use-t";
import { PaymentDialog } from "./payment-dialog";
import { PaymentRow } from "./payment-row";
import type { MonthCurrencyTotal, PaymentFilters, PaymentItem, ScanState } from "./payments-types";
import {
	filterOptions,
	filterPayments,
	monthLabel,
	monthTotals,
	STATUS_FILTERS,
	STATUS_LABELS,
	totalsByMonth,
} from "./payments-utils";
import { financeWrite } from "./subscription-writes";
import { usePaymentList } from "./use-payments";

/** At most this many month blocks are shown above the list; the filter reaches older months. */
const MONTH_BLOCKS = 3;

function TotalLine({ total, locale }: { total: MonthCurrencyTotal; locale: string | undefined }) {
	const t = useT();
	const money = (minor: number) => formatMoney(minor, total.currency, locale ?? "en");
	return (
		<li className="flex flex-wrap gap-x-4 gap-y-1 text-sm" data-payment-total={total.currency}>
			<span className="font-medium text-neutral-900">
				{t("Paid")} <span dir="ltr">{money(total.paidMinor)}</span>
			</span>
			{total.refundedMinor > 0 && (
				<span className="text-neutral-600">
					{t("Refunded")} <span dir="ltr">{money(total.refundedMinor)}</span>
				</span>
			)}
			{total.openMinor > 0 && (
				<span className="text-amber-800">
					{t("Open")} <span dir="ltr">{money(total.openMinor)}</span>
				</span>
			)}
		</li>
	);
}

/** One block per month with a line per currency; amounts in different currencies are never added together. */
function MonthTotals({ totals, locale }: { totals: MonthCurrencyTotal[]; locale: string | undefined }) {
	const t = useT();
	const months = totalsByMonth(totals).slice(0, MONTH_BLOCKS);
	if (months.length === 0) return null;
	return (
		<section aria-label={t("Month totals")} className="grid gap-3 sm:grid-cols-3" data-payment-months>
			{months.map(({ month, lines }) => (
				<div key={month} className={`${CARD_CLASS} p-4`} data-payment-month={month}>
					<h2 className="mb-2 text-xs font-medium text-neutral-500">{monthLabel(month, locale)}</h2>
					<ul className="space-y-1">
						{lines.map((line) => (
							<TotalLine key={line.currency} total={line} locale={locale} />
						))}
					</ul>
				</div>
			))}
		</section>
	);
}

function scanText(scan: ScanState, t: ReturnType<typeof useT>): string {
	const values = { scanned: scan.scanned, recorded: scan.recorded };
	if (scan.status === "running")
		return t("Scanning the last 90 days: {scanned, plural, one {# message} other {# messages}} checked so far", values);
	return t(
		"Last scan: {recorded, plural, =0 {no new payments} one {# new payment} other {# new payments}} in {scanned, plural, one {# message} other {# messages}}",
		values,
	);
}

function ScanButton({ scan, onStarted }: { scan: ScanState | null; onStarted: () => void }) {
	const t = useT();
	const [starting, setStarting] = useState(false);
	const running = scan?.status === "running";
	async function start() {
		setStarting(true);
		const result = await financeWrite("/api/finance/payments/scan", "POST", undefined, t("Could not start the scan"));
		setStarting(false);
		if ("error" in result) toast.error(result.error);
		else onStarted();
	}
	return (
		<Button
			type="button"
			size="sm"
			variant="outline"
			className="h-8 text-sm"
			disabled={starting || running}
			onClick={() => void start()}
			data-payment-scan
		>
			<ScanSearch aria-hidden className="h-4 w-4" />
			{running ? t("Scanning…") : t("Scan last 90 days")}
		</Button>
	);
}

function Filters({
	items,
	filters,
	onChange,
	locale,
}: {
	items: PaymentItem[];
	filters: PaymentFilters;
	onChange: (filters: PaymentFilters) => void;
	locale: string | undefined;
}) {
	const t = useT();
	const { vendors, months } = filterOptions(items);
	return (
		<div className="flex flex-wrap gap-2" data-payment-filters>
			<Select
				aria-label={t("Vendor")}
				containerClassName="flex h-8 text-sm"
				value={filters.vendor}
				onChange={(event) => onChange({ ...filters, vendor: event.target.value })}
			>
				<option value="">{t("All vendors")}</option>
				{vendors.map((vendor) => (
					<option key={vendor} value={vendor}>
						{vendor}
					</option>
				))}
			</Select>
			<Select
				aria-label={t("Month")}
				containerClassName="flex h-8 text-sm"
				value={filters.month}
				onChange={(event) => onChange({ ...filters, month: event.target.value })}
			>
				<option value="">{t("All months")}</option>
				{months.map((month) => (
					<option key={month} value={month}>
						{monthLabel(month, locale)}
					</option>
				))}
			</Select>
			<Select
				aria-label={t("Status")}
				containerClassName="flex h-8 text-sm"
				value={filters.status}
				onChange={(event) => onChange({ ...filters, status: event.target.value as PaymentFilters["status"] })}
			>
				<option value="">{t("All statuses")}</option>
				{STATUS_FILTERS.map((status) => (
					<option key={status} value={status}>
						{t(STATUS_LABELS[status])}
					</option>
				))}
			</Select>
		</div>
	);
}

/**
 * The Payments tab of Money Watch: every payment, invoice, refund and credit note found in mail and every document of
 * a tracked subscription, with month totals per currency, filters and "Scan last 90 days".
 */
export function PaymentsView() {
	const t = useT();
	const { list, failed, reload } = usePaymentList();
	const [filters, setFilters] = useState<PaymentFilters>({ vendor: "", month: "", status: "" });
	const [correcting, setCorrecting] = useState<PaymentItem | null>(null);
	const locale = currentLocale();
	const items = list?.payments ?? [];
	const shown = filterPayments(items, filters);
	// Unfiltered, the server's totals also cover rows past the list's cap.
	const unfiltered = !filters.vendor && !filters.month && !filters.status;
	return (
		<div className="space-y-6" data-payments-view>
			{failed && (
				<p role="alert" className="text-sm text-red-600">
					{t("Could not load your payments.")}
				</p>
			)}
			{list?.migrationPending && (
				<p className={`${CARD_CLASS} p-5 text-sm text-neutral-600`}>
					{t("The database update for payments in Money Watch has not been applied yet.")}
				</p>
			)}
			{list && !list.migrationPending && (
				<>
					<div className="flex flex-wrap items-center justify-between gap-3">
						<p className="text-sm text-neutral-600" data-payment-scan-status>
							{list.scan ? scanText(list.scan, t) : t("Payments that arrive by mail are added here on their own.")}
						</p>
						<ScanButton scan={list.scan} onStarted={reload} />
					</div>
					{items.length === 0 ? (
						<EmptyState
							icon={Receipt}
							title={t("No payments yet")}
							description={t(
								"Receipts, invoices, refunds and credit notes that arrive by mail show up here, with totals per month. Scan the last 90 days to add the mail you already have.",
							)}
						/>
					) : (
						<>
							<MonthTotals totals={unfiltered ? list.months : monthTotals(shown)} locale={locale} />
							<Filters items={items} filters={filters} onChange={setFilters} locale={locale} />
							{shown.length === 0 ? (
								<p className="text-sm text-neutral-600">{t("No payments match these filters.")}</p>
							) : (
								<>
									<ul className={`divide-y divide-neutral-200 overflow-hidden ${CARD_CLASS}`} data-payment-list>
										{shown.map((item) => (
											<PaymentRow
												key={item.id}
												item={item}
												locale={locale}
												onCorrect={setCorrecting}
												onChanged={reload}
											/>
										))}
									</ul>
									{list.truncated && (
										<p className="text-xs text-neutral-500" data-payment-truncated>
											{t("Only the newest 1,000 are listed; the month totals cover every payment.")}
										</p>
									)}
								</>
							)}
						</>
					)}
				</>
			)}
			<PaymentDialog item={correcting} onClose={() => setCorrecting(null)} onChanged={reload} />
		</div>
	);
}
