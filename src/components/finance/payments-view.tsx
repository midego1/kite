"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import toast from "react-hot-toast";
import { Download, Receipt, ScanSearch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/page";
import { CARD_CLASS } from "@/components/ui/page-utils";
import { Select } from "@/components/ui/select";
import { formatMoney } from "@/lib/finance/amount-utils";
import { NO_CATEGORY } from "@/lib/finance/payment-filter-utils";
import { currentLocale } from "@/lib/i18n/translator";
import { useT } from "@/lib/i18n/use-t";
import { cn } from "@/lib/utils";
import { PaymentDialog } from "./payment-dialog";
import { PaymentRow } from "./payment-row";
import type { MonthCurrencyTotal, PaymentFilters, PaymentItem, ScanCoverageGap, ScanState } from "./payments-types";
import {
	CATEGORIES,
	CATEGORY_LABELS,
	anyFilter,
	exportHref,
	filterOptions,
	filterPayments,
	monthLabel,
	monthTotals,
	scanCoverageTexts,
	scanText,
	STATUS_FILTERS,
	STATUS_LABELS,
	totalsByMonth,
} from "./payments-utils";
import { financeWrite } from "./subscription-writes";
import { usePaymentList } from "./use-payments";

/** At most this many month blocks are shown above the list; the filter reaches older months. */
const MONTH_BLOCKS = 3;

const EMPTY_FILTERS: PaymentFilters = { vendor: "", month: "", status: "", category: "" };

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

function ScanButton({ scan, onStarted }: { scan: ScanState | null; onStarted: () => void }) {
	const t = useT();
	const [starting, setStarting] = useState(false);
	const running = scan?.status === "running";
	const failed = scan?.status === "failed";
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
			{running ? t("Scanning…") : failed ? t("Try again") : t("Scan last 90 days")}
		</Button>
	);
}

/** Downloads the rows the filters show as CSV; a link, so the browser saves the file the server builds. */
function ExportButton({ filters, disabled }: { filters: PaymentFilters; disabled: boolean }) {
	const t = useT();
	return (
		<Button
			asChild
			size="sm"
			variant="outline"
			className={cn("h-8 text-sm", disabled && "pointer-events-none opacity-50")}
		>
			<a href={exportHref(filters)} download aria-disabled={disabled} data-payment-export>
				<Download aria-hidden className="h-4 w-4" />
				{t("Export CSV")}
			</a>
		</Button>
	);
}

/** The line over the one payment a search result or a record link opened, with the way back to the whole list. */
function FocusNote({ found }: { found: boolean }) {
	const t = useT();
	return (
		<p className="text-sm text-neutral-600" data-payment-focus>
			{found ? t("Showing one payment.") : t("That payment is not listed.")}{" "}
			<Link href="/finance?tab=payments" className="font-medium text-blue-700 hover:underline">
				{t("Show all payments")}
			</Link>
		</p>
	);
}

function ScanCoverageNote({ gaps }: { gaps: ScanCoverageGap[] }) {
	const t = useT();
	const texts = scanCoverageTexts(gaps, t);
	if (texts.length === 0) return null;
	return (
		<div className="space-y-1" data-payment-scan-coverage>
			{texts.map((text) => (
				<p key={text} className="text-xs text-neutral-500">
					{text}
				</p>
			))}
		</div>
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
				aria-label={t("Category")}
				containerClassName="flex h-8 text-sm"
				value={filters.category}
				onChange={(event) => onChange({ ...filters, category: event.target.value })}
				data-payment-category-filter
			>
				<option value="">{t("All categories")}</option>
				<option value={NO_CATEGORY}>{t("No category")}</option>
				{CATEGORIES.map((category) => (
					<option key={category} value={category}>
						{t(CATEGORY_LABELS[category])}
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
	const [filters, setFilters] = useState<PaymentFilters>({ vendor: "", month: "", status: "", category: "" });
	const [correcting, setCorrecting] = useState<PaymentItem | null>(null);
	// A search result or a record link opens the tab on one payment (`?payment=<id>`).
	const focusId = useSearchParams().get("payment");
	const locale = currentLocale();
	const items = list?.payments ?? [];
	const shown = focusId ? items.filter((item) => item.id === focusId) : filterPayments(items, filters);
	// Unfiltered, the server's totals also cover rows past the list's cap.
	const unfiltered = !focusId && !anyFilter(filters);
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
						<div className="flex flex-wrap items-center gap-2">
							<ExportButton filters={focusId ? EMPTY_FILTERS : filters} disabled={items.length === 0} />
							<ScanButton scan={list.scan} onStarted={reload} />
						</div>
					</div>
					<ScanCoverageNote gaps={list.scanCoverage} />
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
							{focusId ? (
								<FocusNote found={shown.length > 0} />
							) : (
								<Filters items={items} filters={filters} onChange={setFilters} locale={locale} />
							)}
							{shown.length === 0 ? (
								!focusId && <p className="text-sm text-neutral-600">{t("No payments match these filters.")}</p>
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
