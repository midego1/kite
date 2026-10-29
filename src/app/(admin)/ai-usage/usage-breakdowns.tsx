"use client";

import { CARD_CLASS, TABLE_HEAD_CLASS } from "@/components/ui/page-utils";
import type { UsageBreakdownRow } from "@/lib/ai/usage-report-types";
import { cn } from "@/lib/utils";
import type { UsageMetric, UsageSectionProps } from "./types";
import {
	METRIC_LABELS,
	formatEstimatedUsd,
	formatFeature,
	formatPercent,
	formatTokenCount,
	formatUsageProvider,
	metricValue,
	totalCostMicros,
} from "./utils";

function BreakdownTable({
	title,
	rows,
	metric,
	label,
}: {
	title: string;
	rows: (UsageBreakdownRow & { label?: string })[];
	metric: UsageMetric;
	label: (row: UsageBreakdownRow & { label?: string }) => string;
}) {
	const total = rows.reduce((sum, row) => sum + metricValue(row, metric), 0);
	return (
		<section className={cn(CARD_CLASS, "min-w-0 overflow-hidden")} aria-label={title}>
			<h3 className="px-4 pb-3 pt-4 text-sm font-semibold text-neutral-900">{title}</h3>
			<div className="overflow-x-auto">
				<table className="w-full min-w-[600px] text-left text-sm">
					<thead className={TABLE_HEAD_CLASS}>
						<tr>
							<th scope="col" className="px-4 py-2">
								Name
							</th>
							<th scope="col" className="px-3 py-2 text-right">
								Requests
							</th>
							<th scope="col" className="px-3 py-2 text-right">
								Tokens
							</th>
							<th scope="col" className="px-3 py-2 text-right">
								Cost
							</th>
							<th scope="col" className="px-4 py-2 text-right">
								Share of {METRIC_LABELS[metric].toLowerCase()}
							</th>
						</tr>
					</thead>
					<tbody className="divide-y divide-neutral-200">
						{rows.map((row) => {
							const value = metricValue(row, metric);
							return (
								<tr key={row.key}>
									<td className="min-w-40 max-w-72 px-4 py-2 text-neutral-900 [overflow-wrap:anywhere]">
										{label(row)}
									</td>
									<td className="px-3 py-2 text-right tabular-nums">
										{formatTokenCount(row.requests)}
										{row.failedRequests > 0 && (
											<span className="block text-xs text-red-700">{formatTokenCount(row.failedRequests)} failed</span>
										)}
									</td>
									<td className="px-3 py-2 text-right tabular-nums">
										{formatTokenCount(row.inputTokens + row.outputTokens)}
									</td>
									<td className="px-3 py-2 text-right tabular-nums">
										{formatEstimatedUsd(totalCostMicros(row))}
										{row.estimatedRequests > 0 && (
											<span className="block text-xs text-neutral-500">incl. estimate</span>
										)}
										{row.unratedRequests > 0 && (
											<span className="block text-xs text-amber-800">
												{formatTokenCount(row.unratedRequests)} without rate
											</span>
										)}
									</td>
									<td className="px-4 py-2">
										<div className="flex items-center justify-end gap-2">
											<span className="h-1.5 w-16 overflow-hidden rounded-full bg-neutral-100" aria-hidden="true">
												<span
													className="block h-full rounded-full bg-blue-600"
													style={{ width: total ? `${(value / total) * 100}%` : 0 }}
												/>
											</span>
											<span className="w-10 text-right tabular-nums text-neutral-700">
												{formatPercent(value, total)}
											</span>
										</div>
									</td>
								</tr>
							);
						})}
						{rows.length === 0 && (
							<tr>
								<td colSpan={5} className="px-4 py-6 text-center text-neutral-500">
									No requests in this range.
								</td>
							</tr>
						)}
					</tbody>
				</table>
			</div>
		</section>
	);
}

/** Requests, tokens, cost and share by model, provider, feature and mailbox. */
export function UsageBreakdowns({ report, metric }: UsageSectionProps) {
	const { breakdowns } = report;
	return (
		<section className="space-y-3" aria-labelledby="breakdowns-title">
			<div>
				<h2 id="breakdowns-title" className="text-base font-semibold text-neutral-900">
					Breakdowns
				</h2>
				<p className="mt-0.5 text-sm text-neutral-500">
					Share follows the chart&apos;s metric. Cost includes estimates for requests that stored none. Mailboxes you
					cannot open are counted together.
				</p>
			</div>
			<div className="grid gap-4 2xl:grid-cols-2">
				<BreakdownTable title="By model" rows={breakdowns.model} metric={metric} label={(row) => row.key} />
				<BreakdownTable
					title="By provider"
					rows={breakdowns.provider}
					metric={metric}
					label={(row) => formatUsageProvider(row.key)}
				/>
				<BreakdownTable
					title="By feature"
					rows={breakdowns.feature}
					metric={metric}
					label={(row) => formatFeature(row.key)}
				/>
				<BreakdownTable
					title="By mailbox"
					rows={breakdowns.mailbox}
					metric={metric}
					label={(row) => row.label ?? row.key}
				/>
			</div>
		</section>
	);
}
