"use client";

import { Fragment, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { CARD_CLASS, TABLE_HEAD_CLASS } from "@/components/ui/page-utils";
import type { UsageActivityRow, UsageFilters } from "@/lib/ai/usage-report-types";
import { isUsageRowStatus } from "@/lib/ai/usage-report-utils";
import { cn } from "@/lib/utils";
import type { UsageActivityProps } from "./types";
import {
	STATUS_LABELS,
	formatDuration,
	formatErrorCode,
	formatEstimatedUsd,
	formatFeature,
	formatRate,
	formatTokenCount,
	formatUsageDate,
	formatUsageProvider,
} from "./utils";

const STATUS_TEXT: Record<UsageActivityRow["status"], string> = {
	ok: "text-neutral-700",
	failed: "text-red-700",
	stopped: "text-amber-800",
	running: "text-blue-700",
	unrecorded: "text-neutral-500",
};

function FilterSelect({
	label,
	value,
	options,
	onChange,
	disabled,
}: {
	label: string;
	value: string | undefined;
	options: { value: string; label: string }[];
	onChange: (value: string | undefined) => void;
	disabled: boolean;
}) {
	return (
		<label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-neutral-500">
			{label}
			<Select
				aria-label={label}
				value={value ?? ""}
				disabled={disabled}
				containerClassName="h-9 w-full bg-white"
				className="text-sm text-neutral-900"
				onChange={(event) => onChange(event.target.value || undefined)}
			>
				<option value="">All</option>
				{options.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</Select>
		</label>
	);
}

function costText(row: UsageActivityRow) {
	if (row.costUsdMicros !== null) return formatEstimatedUsd(row.costUsdMicros);
	if (row.estimatedCostUsdMicros !== null) return `${formatEstimatedUsd(row.estimatedCostUsdMicros)} est.`;
	return "—";
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="min-w-0">
			<dt className="text-xs text-neutral-500">{label}</dt>
			<dd className="mt-0.5 break-words text-neutral-900">{children}</dd>
		</div>
	);
}

function RowDetails({ row, detailsRecorded }: { row: UsageActivityRow; detailsRecorded: boolean }) {
	const notRecorded = detailsRecorded ? "Not recorded for this request" : "Recorded after the database update";
	return (
		<dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
			<Detail label="Feature">{formatFeature(row.source)}</Detail>
			<Detail label="Mailbox">{row.mailboxLabel ?? (row.mailboxId ? "A mailbox you cannot open" : "None")}</Detail>
			<Detail label="Status">
				<span className={STATUS_TEXT[row.status]}>{STATUS_LABELS[row.status]}</span>
				{row.errorCode && ` · ${formatErrorCode(row.errorCode)} (${row.errorCode})`}
			</Detail>
			<Detail label="Duration">{row.durationMs === null ? notRecorded : formatDuration(row.durationMs)}</Detail>
			<Detail label="Finish reason">{row.finishReason ?? notRecorded}</Detail>
			<Detail label="Cost">
				{row.costUsdMicros !== null
					? `${formatEstimatedUsd(row.costUsdMicros)} recorded`
					: row.estimatedCostUsdMicros !== null
						? `${formatEstimatedUsd(row.estimatedCostUsdMicros)} estimated at today's rate`
						: "No rate, so no cost"}
			</Detail>
			<Detail label="Rate used">
				{row.rate
					? `${formatRate(row.rate)}${row.rate.kind === "current" ? " (today's rate)" : ""}`
					: row.costUsdMicros !== null
						? notRecorded
						: "None"}
			</Detail>
			<Detail label="Tokens">
				{formatTokenCount(row.inputTokens)} input · {formatTokenCount(row.outputTokens)} output
			</Detail>
			{row.jobId && <Detail label="Job">{row.jobId}</Detail>}
		</dl>
	);
}

/** Every request in the range, newest first, with filters and a detail row per request. */
export function UsageActivity({ report, loading, onFiltersChange, onPageChange }: UsageActivityProps) {
	const [expanded, setExpanded] = useState<string | null>(null);
	const { filters, filterOptions } = report;
	const setFilter = (key: keyof UsageFilters, value: string | undefined) => {
		const next: UsageFilters = { ...filters };
		if (key === "status") next.status = isUsageRowStatus(value) ? value : undefined;
		else next[key] = value;
		onFiltersChange(next);
	};
	const filtered = Object.values(filters).some(Boolean);
	const withCurrent = (values: string[], current: string | undefined) =>
		current && !values.includes(current) ? [...values, current] : values;
	return (
		<section className="space-y-3" aria-labelledby="activity-title">
			<div className="flex flex-wrap items-end justify-between gap-3">
				<div>
					<h2 id="activity-title" className="text-base font-semibold text-neutral-900">
						Activity
					</h2>
					<p className="mt-0.5 text-sm text-neutral-500">
						{formatTokenCount(report.totalRows)} {report.totalRows === 1 ? "request" : "requests"}
						{filtered ? (report.totalRows === 1 ? " matches the filters" : " match the filters") : " in this range"}.
						Open a row for its details.
					</p>
				</div>
				{filtered && (
					<Button type="button" variant="ghost" size="sm" disabled={loading} onClick={() => onFiltersChange({})}>
						Clear filters
					</Button>
				)}
			</div>
			<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
				<FilterSelect
					label="Model"
					value={filters.model}
					options={withCurrent(filterOptions.models, filters.model).map((value) => ({ value, label: value }))}
					onChange={(value) => setFilter("model", value)}
					disabled={loading}
				/>
				<FilterSelect
					label="Provider"
					value={filters.provider}
					options={withCurrent(filterOptions.providers, filters.provider).map((value) => ({
						value,
						label: formatUsageProvider(value),
					}))}
					onChange={(value) => setFilter("provider", value)}
					disabled={loading}
				/>
				<FilterSelect
					label="Feature"
					value={filters.feature}
					options={withCurrent(filterOptions.features, filters.feature).map((value) => ({
						value,
						label: formatFeature(value),
					}))}
					onChange={(value) => setFilter("feature", value)}
					disabled={loading}
				/>
				<FilterSelect
					label="Status"
					value={filters.status}
					options={withCurrent(filterOptions.statuses, filters.status).map((value) => ({
						value,
						label: isUsageRowStatus(value) ? STATUS_LABELS[value] : value,
					}))}
					onChange={(value) => setFilter("status", value)}
					disabled={loading}
				/>
			</div>
			<section
				role="region"
				tabIndex={0}
				aria-label="AI usage"
				aria-busy={loading}
				className={cn(CARD_CLASS, "overflow-x-auto")}
			>
				<table className="w-full min-w-[900px] text-left text-sm">
					<thead className={TABLE_HEAD_CLASS}>
						<tr>
							<th scope="col" className="w-10 px-2 py-3">
								<span className="sr-only">Details</span>
							</th>
							<th scope="col" className="px-3 py-3">
								Date & time
							</th>
							<th scope="col" className="px-3 py-3">
								Model
							</th>
							<th scope="col" className="px-3 py-3">
								Feature
							</th>
							<th scope="col" className="px-3 py-3">
								Status
							</th>
							<th scope="col" className="px-3 py-3 text-right">
								Input tokens
							</th>
							<th scope="col" className="px-3 py-3 text-right">
								Output tokens
							</th>
							<th scope="col" className="px-4 py-3 text-right">
								Spending
							</th>
						</tr>
					</thead>
					<tbody className="divide-y divide-neutral-200">
						{report.rows.map((row) => {
							const open = expanded === row.id;
							const detailsId = `usage-row-${row.id}`;
							return (
								<Fragment key={row.id}>
									<tr
										className={cn("cursor-pointer hover:bg-[#f2f6fc]", open && "bg-[#f6f8fc]")}
										onClick={() => setExpanded(open ? null : row.id)}
									>
										<td className="px-2 py-2.5">
											<button
												type="button"
												aria-expanded={open}
												aria-controls={open ? detailsId : undefined}
												aria-label={`Details of the ${formatFeature(row.source)} request at ${formatUsageDate(row.createdAt)}`}
												className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
												onClick={(event) => {
													event.stopPropagation();
													setExpanded(open ? null : row.id);
												}}
											>
												<ChevronRight
													className={cn("h-4 w-4 transition-transform", open && "rotate-90")}
													aria-hidden="true"
												/>
											</button>
										</td>
										<td className="whitespace-nowrap px-3 py-2.5 text-neutral-600">{formatUsageDate(row.createdAt)}</td>
										<td className="min-w-44 max-w-64 px-3 py-2.5 [overflow-wrap:anywhere]">
											{row.model}
											<span className="block text-xs text-neutral-500">{formatUsageProvider(row.provider)}</span>
										</td>
										<td className="px-3 py-2.5">{formatFeature(row.source)}</td>
										<td className={cn("px-3 py-2.5", STATUS_TEXT[row.status])}>
											{STATUS_LABELS[row.status]}
											{row.errorCode && <span className="block text-xs">{formatErrorCode(row.errorCode)}</span>}
										</td>
										<td className="px-3 py-2.5 text-right tabular-nums">{formatTokenCount(row.inputTokens)}</td>
										<td className="px-3 py-2.5 text-right tabular-nums">{formatTokenCount(row.outputTokens)}</td>
										<td className="px-4 py-2.5 text-right tabular-nums">{costText(row)}</td>
									</tr>
									{open && (
										<tr id={detailsId} className="bg-[#f6f8fc]">
											<td />
											<td colSpan={7} className="px-3 pb-4 pt-1">
												<RowDetails row={row} detailsRecorded={report.detailsRecorded} />
											</td>
										</tr>
									)}
								</Fragment>
							);
						})}
						{report.rows.length === 0 && (
							<tr>
								<td colSpan={8} className="px-4 py-8 text-center text-neutral-500">
									{filtered ? "No requests match these filters." : "No AI usage in this range."}
								</td>
							</tr>
						)}
					</tbody>
				</table>
			</section>
			<div className="flex flex-wrap items-center justify-end gap-3 text-sm text-neutral-600">
				<span>
					Page {report.page} of {report.totalPages} · {report.pageSize} per page
				</span>
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={loading || report.page <= 1}
					onClick={() => onPageChange(report.page - 1)}
				>
					Previous
				</Button>
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={loading || report.page >= report.totalPages}
					onClick={() => onPageChange(report.page + 1)}
				>
					Next
				</Button>
			</div>
		</section>
	);
}
