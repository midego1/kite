import type { UsageBreakdownRow, UsageDay } from "@/lib/ai/usage-report-types";
import type { UsageMetric } from "./types";
import { metricValue } from "./utils";

/** The two stacked parts of each metric's bars, bottom first. Legends and tooltips name them the same way. */
export const CHART_SERIES: Record<UsageMetric, readonly { label: string; className: string }[]> = {
	tokens: [
		{ label: "Input", className: "bg-blue-600" },
		{ label: "Output", className: "bg-sky-300" },
	],
	cost: [
		{ label: "Recorded", className: "bg-blue-600" },
		{ label: "Estimated", className: "bg-sky-300" },
	],
	requests: [
		{ label: "Succeeded or not recorded", className: "bg-blue-600" },
		{ label: "Failed", className: "bg-red-500" },
	],
};

/** The bottom and top part of a day's bar for `metric`. */
export function chartParts(day: UsageDay, metric: UsageMetric): [number, number] {
	if (metric === "cost") return [day.costUsdMicros, day.estimatedCostUsdMicros];
	if (metric === "requests") return [day.requests - day.failedRequests, day.failedRequests];
	return [day.inputTokens, day.outputTokens];
}

/** Every how many days the axis names a date, so 7, 30 or 90 bars get about seven labels. */
export function axisLabelEvery(count: number) {
	return Math.max(1, Math.ceil(count / 7));
}

/** Gap between the hovered bar and the tooltip beside it. */
const TOOLTIP_GAP = 12;

/**
 * The tooltip's left edge for a bar centred at `x` in a chart `width` wide: beside the bar on the right, or on the
 * left where the right has no room, so it does not cover the bar; never outside the chart.
 */
export function tooltipLeft(x: number, width: number, tooltipWidth: number) {
	const right = x + TOOLTIP_GAP;
	const left = right + tooltipWidth <= width ? right : x - TOOLTIP_GAP - tooltipWidth;
	return Math.round(Math.max(0, Math.min(width - tooltipWidth, left)));
}

/** Highest the tooltip starts below the chart's top, so a tall tooltip beside a short bar stays near the chart. */
const TOOLTIP_TOP_MAX = 96;

/** The tooltip's top edge: level with the top of the hovered bar (`barTop` from the chart's top), within limits. */
export function tooltipTop(barTop: number) {
	return Math.round(Math.max(0, Math.min(TOOLTIP_TOP_MAX, barTop - 24)));
}

/** The largest rows by `metric`, with the rest folded into one "N more" count. */
export function topRows(rows: readonly UsageBreakdownRow[], metric: UsageMetric, limit = 4) {
	const sorted = [...rows].sort(
		(a, b) => metricValue(b, metric) - metricValue(a, metric) || a.key.localeCompare(b.key),
	);
	return { shown: sorted.slice(0, limit), more: Math.max(0, sorted.length - limit) };
}
