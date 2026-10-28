"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { CARD_CLASS } from "@/components/ui/page-utils";
import type { UsageReport } from "@/lib/ai/usage-report-types";
import { cn } from "@/lib/utils";
import {
	STATUS_LABELS,
	formatErrorCode,
	formatEstimatedUsd,
	formatPercent,
	formatRate,
	formatTokenCount,
	formatUsageProvider,
	totalCostMicros,
} from "./utils";

function SummaryCard({ label, value, children }: { label: string; value: ReactNode; children?: ReactNode }) {
	return (
		<section className={cn(CARD_CLASS, "p-5")}>
			<p className="text-sm text-neutral-500">{label}</p>
			<p className="mt-2 text-2xl font-semibold tabular-nums text-neutral-900">{value}</p>
			{children && <div className="mt-1 space-y-0.5 text-xs text-neutral-500">{children}</div>}
		</section>
	);
}

/** The headline numbers for the range. */
export function UsageSummaryCards({ report }: { report: UsageReport }) {
	const { totals } = report;
	const average = (value: number) => formatTokenCount(totals.requests ? Math.round(value / totals.requests) : 0);
	const succeeded = report.statuses.find((item) => item.status === "ok")?.requests ?? 0;
	return (
		<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
			<SummaryCard label="Total tokens" value={formatTokenCount(totals.totalTokens)}>
				<p>
					{formatTokenCount(totals.inputTokens)} input · {formatTokenCount(totals.outputTokens)} output
				</p>
			</SummaryCard>
			<SummaryCard label="Requests" value={formatTokenCount(totals.requests)}>
				{report.detailsRecorded ? (
					<p>
						{formatTokenCount(succeeded)} succeeded · {formatTokenCount(totals.failedRequests)} failed
					</p>
				) : (
					<p>Success and failure are recorded once the database update is applied.</p>
				)}
			</SummaryCard>
			<SummaryCard label="Estimated spend" value={totals.requests ? formatEstimatedUsd(totalCostMicros(totals)) : "—"}>
				<p>
					{formatEstimatedUsd(totals.costUsdMicros)} recorded
					{totals.estimatedRequests > 0 &&
						` + ${formatEstimatedUsd(totals.estimatedCostUsdMicros)} estimated for ${formatTokenCount(totals.estimatedRequests)} older requests`}
				</p>
				{totals.unratedRequests > 0 && (
					<p>
						<a href="#missing-rates" className="text-blue-700 underline-offset-2 hover:underline">
							{formatTokenCount(totals.unratedRequests)} requests have no rate
						</a>
					</p>
				)}
			</SummaryCard>
			<SummaryCard label="Average per request" value={`${average(totals.totalTokens)} tokens`}>
				<p>
					{average(totals.inputTokens)} input · {average(totals.outputTokens)} output
				</p>
			</SummaryCard>
		</div>
	);
}

/** Which models stored no cost, why, and what the page does about it. */
export function MissingRates({ report }: { report: UsageReport }) {
	if (!report.missingRates.length) return null;
	return (
		<section id="missing-rates" className={cn(CARD_CLASS, "scroll-mt-4 p-5")}>
			<h2 className="text-base font-semibold text-neutral-900">Requests without a stored cost</h2>
			<p className="mt-1 text-sm text-neutral-500">
				A request stores its cost when its model has a rate. Requests from before a rate was set (or before Kite&apos;s
				price list knew the model) are priced here at today&apos;s rate and marked estimated; models with no rate at all
				count against the token allowances instead of the dollar cap.
			</p>
			<ul className="mt-4 divide-y divide-neutral-200 text-sm">
				{report.missingRates.map((item) => (
					<li
						key={`${item.provider}:${item.model}`}
						className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2.5"
					>
						<div className="min-w-0">
							<p className="break-all font-medium text-neutral-900">{item.model}</p>
							<p className="text-xs text-neutral-500">
								{formatUsageProvider(item.provider)} · {formatTokenCount(item.requests)} requests without a cost
							</p>
						</div>
						<div className="text-right text-xs">
							{item.rate ? (
								<p className="text-neutral-600">
									Estimated at {formatRate(item.rate)} (
									{item.rateSource === "saved" ? "your rate" : "Kite's price list"})
								</p>
							) : (
								<p className="font-medium text-amber-800">No rate known</p>
							)}
							{!item.rate &&
								(item.configured ? (
									<Link href="/agent#cost-rates" className="text-blue-700 underline-offset-2 hover:underline">
										Set a rate in Agent settings
									</Link>
								) : (
									<p className="text-neutral-500">No longer in your model list</p>
								))}
						</div>
					</li>
				))}
			</ul>
		</section>
	);
}

function Meter({
	label,
	used,
	cap,
	format,
}: {
	label: string;
	used: number;
	cap: number;
	format: (n: number) => string;
}) {
	const share = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
	return (
		<div>
			<div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
				<span className="text-neutral-700">{label}</span>
				<span className="tabular-nums text-neutral-900">
					{format(used)} <span className="text-neutral-500">of {format(cap)}</span>
				</span>
			</div>
			<div
				role="meter"
				aria-label={label}
				aria-valuemin={0}
				aria-valuemax={cap}
				aria-valuenow={Math.min(used, cap)}
				aria-valuetext={`${format(used)} of ${format(cap)}`}
				className="mt-1.5 h-2 overflow-hidden rounded-full bg-neutral-100"
			>
				<div
					className={cn(
						"h-full rounded-full",
						share >= 100 ? "bg-red-500" : share >= 80 ? "bg-amber-500" : "bg-blue-600",
					)}
					style={{ width: `${share}%` }}
				/>
			</div>
		</div>
	);
}

/** Today's spend against the install cap, the token allowances and each mailbox's own cap. */
export function SpendToday({ report }: { report: UsageReport }) {
	const spend = report.spendToday;
	return (
		<section className={cn(CARD_CLASS, "p-5")} aria-labelledby="spend-today-title">
			<div className="flex flex-wrap items-start justify-between gap-2">
				<div>
					<h2 id="spend-today-title" className="text-base font-semibold text-neutral-900">
						Today&apos;s spend and caps
					</h2>
					<p className="mt-1 text-xs text-neutral-500">
						Since 00:00 UTC, when the caps reset. Models with a rate count against the dollar caps, models without one
						against the token allowances.
					</p>
				</div>
				<Link href="/agent" className="text-sm text-blue-700 underline-offset-2 hover:underline">
					Change caps
				</Link>
			</div>
			<div className="mt-4 space-y-4">
				<Meter
					label="Install daily spend cap"
					used={spend.installSpentMicros}
					cap={spend.installCapMicros}
					format={formatEstimatedUsd}
				/>
				<Meter
					label="Chat and writing token allowance"
					used={spend.chatTokensUsed}
					cap={spend.chatTokenCap}
					format={formatTokenCount}
				/>
				<Meter
					label="Automatic reading token allowance"
					used={spend.autoReadTokensUsed}
					cap={spend.autoReadTokenCap}
					format={formatTokenCount}
				/>
				{spend.mailboxes.map((mailbox) => (
					<Meter
						key={mailbox.id}
						label={`${mailbox.label} daily cap`}
						used={mailbox.spentMicros}
						cap={mailbox.capMicros}
						format={formatEstimatedUsd}
					/>
				))}
			</div>
		</section>
	);
}

/** Succeeded versus failed requests and the most common error codes. */
export function UsageOutcomes({ report }: { report: UsageReport }) {
	const total = report.totals.requests;
	return (
		<section className={cn(CARD_CLASS, "p-5")} aria-labelledby="outcomes-title">
			<h2 id="outcomes-title" className="text-base font-semibold text-neutral-900">
				Outcomes
			</h2>
			<p className="mt-1 text-xs text-neutral-500">
				{report.detailsRecorded
					? "How each request ended. Requests from before this was recorded show as not recorded."
					: "Apply the pending database update to record how each request ends."}
			</p>
			{total > 0 && (
				<div className="mt-4 flex h-2 overflow-hidden rounded-full bg-neutral-100" aria-hidden="true">
					{report.statuses.map((item) => (
						<div
							key={item.status}
							className={STATUS_BAR[item.status]}
							style={{ width: `${(item.requests / total) * 100}%` }}
						/>
					))}
				</div>
			)}
			<dl className="mt-3 grid grid-cols-[1fr_auto_auto] gap-x-3 gap-y-1 text-sm">
				{report.statuses.map((item) => (
					<div key={item.status} className="contents">
						<dt className="flex items-center gap-2 text-neutral-700">
							<span className={cn("h-2.5 w-2.5 rounded-sm", STATUS_BAR[item.status])} aria-hidden="true" />
							{STATUS_LABELS[item.status]}
						</dt>
						<dd className="text-right tabular-nums text-neutral-900">{formatTokenCount(item.requests)}</dd>
						<dd className="text-right tabular-nums text-neutral-500">{formatPercent(item.requests, total)}</dd>
					</div>
				))}
			</dl>
			{report.errorCodes.length > 0 && (
				<div className="mt-4 border-t border-neutral-200 pt-3">
					<h3 className="text-sm font-semibold text-neutral-900">Top errors</h3>
					<ul className="mt-2 space-y-1 text-sm">
						{report.errorCodes.slice(0, 5).map((item) => (
							<li key={item.code} className="flex justify-between gap-3">
								<span className="text-neutral-700">
									{formatErrorCode(item.code)} <span className="text-xs text-neutral-500">({item.code})</span>
								</span>
								<span className="tabular-nums text-neutral-900">{formatTokenCount(item.requests)}</span>
							</li>
						))}
					</ul>
				</div>
			)}
		</section>
	);
}

const STATUS_BAR: Record<keyof typeof STATUS_LABELS, string> = {
	ok: "bg-blue-600",
	failed: "bg-red-500",
	stopped: "bg-amber-500",
	running: "bg-sky-300",
	unrecorded: "bg-neutral-300",
};
