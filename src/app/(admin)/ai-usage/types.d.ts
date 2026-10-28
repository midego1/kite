import type { UsageDay, UsageFilters, UsageReport } from "@/lib/ai/usage-report-types";

/** What the chart's bars and the breakdowns' share measure. */
export type UsageMetric = "tokens" | "cost" | "requests";

export type UsageChartProps = {
	daily: UsageDay[];
	timeZone: string;
	metric: UsageMetric;
	onMetricChange: (metric: UsageMetric) => void;
};

export type UsageSectionProps = { report: UsageReport; metric: UsageMetric };

export type UsageActivityProps = {
	report: UsageReport;
	loading: boolean;
	onFiltersChange: (filters: UsageFilters) => void;
	onPageChange: (page: number) => void;
};
