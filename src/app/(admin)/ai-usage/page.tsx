"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { BarChart3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/ui/page";
import type { UsageFilters, UsageRange, UsageReport } from "@/lib/ai/usage-report-types";
import { DEFAULT_USAGE_RANGE } from "@/lib/ai/usage-report-utils";
import { cn } from "@/lib/utils";
import type { UsageMetric } from "./types";
import { fetchAiUsage } from "./utils";
import { SegmentedControl } from "./segmented-control";
import { UsageChart } from "./usage-chart";
import { MissingRates, SpendToday, UsageOutcomes, UsageSummaryCards } from "./usage-summary";
import { UsageBreakdowns } from "./usage-breakdowns";
import { UsageActivity } from "./usage-activity";

const RANGE_OPTIONS = [7, 30, 90].map((value) => ({ value: value as UsageRange, label: `${value} days` }));

export default function AiUsagePage() {
	const [metric, setMetric] = useState<UsageMetric>("tokens");
	// A range change loads the whole report; a filter or page change only the activity page (`activityOnly`).
	const [query, setQuery] = useState<{
		range: UsageRange;
		page: number;
		filters: UsageFilters;
		activityOnly: boolean;
	}>({ range: DEFAULT_USAGE_RANGE, page: 1, filters: {}, activityOnly: false });
	// The last answer and the request it answered; the page is loading while that is not the current request.
	const [result, setResult] = useState<{ key: string; error?: string } | null>(null);
	const [data, setData] = useState<UsageReport | null>(null);
	const key = JSON.stringify(query);
	const loading = result?.key !== key;
	const error = result?.key === key ? (result.error ?? null) : null;

	useEffect(() => {
		let active = true;
		void fetchAiUsage(query.range, query.page, query.filters, query.activityOnly)
			.then((answer) => {
				if (!active) return;
				setData((current) => (query.activityOnly && current ? { ...current, ...answer } : (answer as UsageReport)));
				setResult({ key });
			})
			.catch((cause) => {
				if (active) setResult({ key, error: cause instanceof Error ? cause.message : "Could not load AI usage" });
			});
		return () => {
			active = false;
		};
	}, [key, query]);

	return (
		<div className="space-y-6">
			<PageHeader
				title="AI Usage"
				description={
					data
						? `Requests, tokens and estimated spend over the last ${data.range} days (${data.timeZone}).`
						: "Requests, tokens and estimated spend."
				}
				actions={
					<Button asChild variant="outline">
						<Link href="/agent">Back to Agent</Link>
					</Button>
				}
			/>
			<SegmentedControl
				label="Date range"
				value={query.range}
				options={RANGE_OPTIONS}
				onChange={(range) => setQuery((current) => ({ ...current, range, page: 1, activityOnly: false }))}
			/>
			{error && (
				<p role="alert" className="text-sm text-red-700">
					{error}
				</p>
			)}
			{data && !data.detailsRecorded && (
				<p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
					Apply the pending database update (Admin overview) to record each request&apos;s status, duration, finish
					reason and rate. Until then those details show as not recorded.
				</p>
			)}
			{!data && !error && <p className="text-sm text-neutral-500">Loading usage…</p>}
			{data && (
				<div
					className={cn("space-y-6 transition-opacity", loading && !query.activityOnly && "opacity-60")}
					aria-busy={loading && !query.activityOnly}
				>
					<UsageSummaryCards report={data} />
					{data.totals.requests === 0 && (
						<EmptyState
							icon={BarChart3}
							title="No AI usage in this range"
							description="Requests from chat, Write with Kite, summaries and automatic reading show up here."
						/>
					)}
					<UsageChart daily={data.daily} timeZone={data.timeZone} metric={metric} onMetricChange={setMetric} />
					<MissingRates report={data} />
					<div className="grid gap-4 lg:grid-cols-2">
						<SpendToday report={data} />
						<UsageOutcomes report={data} />
					</div>
					<UsageBreakdowns report={data} metric={metric} />
					<UsageActivity
						report={data}
						loading={loading}
						onFiltersChange={(filters) => setQuery((current) => ({ ...current, page: 1, filters, activityOnly: true }))}
						onPageChange={(page) => setQuery((current) => ({ ...current, page, activityOnly: true }))}
					/>
					<p className="text-xs text-neutral-500">
						Spending is estimated from the per-model rates in Agent settings: yours, the provider&apos;s, or Kite&apos;s
						price list for well-known models. Requests that stored no cost are priced at today&apos;s rate and marked
						estimated. A dash means no rate or token count was available.
					</p>
				</div>
			)}
		</div>
	);
}
