"use client";

import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { UsageBreakdownRow, UsageDay } from "@/lib/ai/usage-report-types";
import { CARD_CLASS } from "@/components/ui/page-utils";
import { cn } from "@/lib/utils";
import type { UsageChartProps, UsageMetric } from "./types";
import { CHART_SERIES, axisLabelEvery, chartParts, tooltipLeft, tooltipTop, topRows } from "./chart-utils";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
	METRIC_LABELS,
	formatCompact,
	formatDailyLabel,
	formatDayHeading,
	formatEstimatedUsd,
	formatFeature,
	formatMetric,
	formatTokenCount,
	metricValue,
	totalCostMicros,
} from "./utils";

const TOOLTIP_WIDTH = 288;

const METRIC_OPTIONS = (["tokens", "cost", "requests"] as const).map((value) => ({
	value,
	label: METRIC_LABELS[value],
}));

function dayLabel(day: UsageDay, metric: UsageMetric) {
	const requests = `${formatTokenCount(day.requests)} ${day.requests === 1 ? "request" : "requests"}`;
	if (metric === "requests") return `${formatDayHeading(day.date)}: ${requests}`;
	const value = formatMetric(metricValue(day, metric), metric);
	return `${formatDayHeading(day.date)}: ${value} ${metric === "cost" ? "estimated cost" : "tokens"}, ${requests}`;
}

export function UsageChart({ daily, timeZone, metric, onMetricChange }: UsageChartProps) {
	// The day whose tooltip shows, and where: measured when it is hovered or focused, not during render. On a narrow
	// chart (`below`) it is shown under the chart instead of over the bars.
	const [active, setActive] = useState<{
		index: number;
		left: number;
		top: number;
		width: number;
		below: boolean;
	} | null>(null);
	const [focusIndex, setFocusIndex] = useState(daily.length - 1);
	const bars = useRef<(HTMLButtonElement | null)[]>([]);
	const frame = useRef<HTMLDivElement | null>(null);
	const tooltipId = useId();
	const max = Math.max(0, ...daily.map((day) => metricValue(day, metric)));
	const every = axisLabelEvery(daily.length);
	const series = CHART_SERIES[metric];
	const current = Math.min(focusIndex, daily.length - 1);

	const show = (index: number) => {
		const button = bars.current[index];
		const bar = button?.getBoundingClientRect();
		const box = frame.current?.getBoundingClientRect();
		if (!button || !bar || !box) return;
		const width = Math.min(TOOLTIP_WIDTH, box.width);
		const barTop = (button.firstElementChild as HTMLElement | null)?.getBoundingClientRect().top ?? bar.top;
		setActive({
			index,
			width,
			left: tooltipLeft(bar.left + bar.width / 2 - box.left, box.width, width),
			top: tooltipTop(barTop - box.top),
			below: box.width < 2 * TOOLTIP_WIDTH + 48,
		});
	};
	// Escape closes the tooltip whether a pointer or the keyboard opened it.
	const open = active !== null;
	useEffect(() => {
		if (!open) return;
		const close = (event: globalThis.KeyboardEvent) => {
			if (event.key === "Escape") setActive(null);
		};
		document.addEventListener("keydown", close);
		return () => document.removeEventListener("keydown", close);
	}, [open]);
	const focusBar = (index: number) => {
		const next = Math.max(0, Math.min(daily.length - 1, index));
		setFocusIndex(next);
		bars.current[next]?.focus();
	};
	const onKeyDown = (event: KeyboardEvent, index: number) => {
		const target = {
			ArrowRight: index + 1,
			ArrowLeft: index - 1,
			Home: 0,
			End: daily.length - 1,
		}[event.key];
		if (target === undefined) return;
		event.preventDefault();
		focusBar(target);
	};

	return (
		<section className={cn(CARD_CLASS, "p-5")} aria-labelledby={`${tooltipId}-title`}>
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h2 id={`${tooltipId}-title`} className="text-base font-semibold text-neutral-900">
						Usage by day
					</h2>
					<p className="mt-1 text-xs text-neutral-500">
						{METRIC_LABELS[metric]} per day over the last {daily.length} days ({timeZone}). Hover over or focus a bar
						for details; arrow keys move between days.
					</p>
				</div>
				<SegmentedControl label="Chart metric" value={metric} options={METRIC_OPTIONS} onChange={onMetricChange} />
			</div>
			<div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-neutral-600" aria-hidden="true">
				{series.map((item) => (
					<span key={item.label} className="flex items-center gap-1.5">
						<span className={cn("h-2.5 w-2.5 rounded-sm", item.className)} /> {item.label}
					</span>
				))}
			</div>
			<div ref={frame} className="relative mt-4 flex gap-2" onPointerLeave={() => setActive(null)}>
				<div className="flex h-48 flex-col justify-between pb-5 text-right text-[11px] tabular-nums text-neutral-500">
					<span>{metric === "cost" ? formatEstimatedUsd(max) : formatCompact(max)}</span>
					<span>0</span>
				</div>
				<div
					role="group"
					aria-label={`${METRIC_LABELS[metric]} per day`}
					className="flex min-w-0 flex-1 items-end gap-px border-b border-neutral-200 sm:gap-1"
				>
					{daily.map((day, index) => {
						const [bottom, top] = chartParts(day, metric);
						const total = bottom + top;
						const height = total && max ? Math.max(2, (total / max) * 100) : 0;
						return (
							<div key={day.date} className="flex h-48 min-w-0 flex-1 flex-col items-center">
								<button
									ref={(node) => {
										bars.current[index] = node;
									}}
									type="button"
									tabIndex={index === current ? 0 : -1}
									aria-label={dayLabel(day, metric)}
									aria-describedby={active?.index === index ? tooltipId : undefined}
									data-date={day.date}
									className={cn(
										"group flex h-[172px] w-full items-end justify-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
										active?.index === index && "bg-neutral-100",
									)}
									onPointerEnter={() => show(index)}
									onFocus={() => {
										setFocusIndex(index);
										show(index);
									}}
									onBlur={() => setActive((value) => (value?.index === index ? null : value))}
									onKeyDown={(event) => onKeyDown(event, index)}
								>
									<span
										className="flex w-full max-w-5 flex-col-reverse gap-px overflow-hidden rounded-t-[3px] group-hover:opacity-90"
										style={{ height: `${height}%` }}
									>
										<span className={cn("w-full", series[0].className)} style={{ flexGrow: bottom }} />
										{top > 0 && <span className={cn("w-full", series[1].className)} style={{ flexGrow: top }} />}
									</span>
								</button>
								<span
									className={cn(
										"h-5 whitespace-nowrap pt-1 text-[11px] leading-4 text-neutral-500",
										index === daily.length - 1 && "self-end",
									)}
									aria-hidden="true"
								>
									{index % every === 0 || index === daily.length - 1 ? formatDailyLabel(day.date) : ""}
								</span>
							</div>
						);
					})}
				</div>
				{active && !active.below && daily[active.index] && (
					<DayTooltip
						id={tooltipId}
						day={daily[active.index]}
						metric={metric}
						style={{ left: active.left, top: active.top, width: active.width }}
					/>
				)}
			</div>
			{active?.below && daily[active.index] && (
				<DayTooltip id={tooltipId} day={daily[active.index]} metric={metric} below />
			)}
		</section>
	);
}

function DayTooltip({
	id,
	day,
	metric,
	style,
	below,
}: {
	id: string;
	day: UsageDay;
	metric: UsageMetric;
	style?: CSSProperties;
	below?: boolean;
}) {
	const cost = totalCostMicros(day);
	return (
		<div
			id={id}
			role="tooltip"
			data-testid="usage-tooltip"
			className={cn(
				"pointer-events-none rounded-lg border border-neutral-200 bg-white p-3 text-xs text-neutral-600",
				below ? "mt-3" : "absolute z-10 shadow-lg",
			)}
			style={style}
		>
			<p className="font-medium text-neutral-900">{formatDayHeading(day.date)}</p>
			<dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 tabular-nums">
				<Stat label="Total tokens" value={formatTokenCount(day.inputTokens + day.outputTokens)} strong />
				<Stat label="Input tokens" value={formatTokenCount(day.inputTokens)} />
				<Stat label="Output tokens" value={formatTokenCount(day.outputTokens)} />
				<Stat label="Requests" value={formatTokenCount(day.requests)} strong />
				{day.failedRequests > 0 && <Stat label="Failed" value={formatTokenCount(day.failedRequests)} />}
				<Stat label="Estimated cost" value={day.requests ? formatEstimatedUsd(cost) : "—"} strong />
				{day.estimatedRequests > 0 && (
					<Stat label="Of which estimated" value={formatEstimatedUsd(day.estimatedCostUsdMicros)} />
				)}
				{day.unratedRequests > 0 && (
					<Stat label="Requests without a rate" value={formatTokenCount(day.unratedRequests)} />
				)}
			</dl>
			<TooltipBreakdown title="By model" rows={day.models} metric={metric} label={(key) => key} />
			<TooltipBreakdown title="By feature" rows={day.features} metric={metric} label={formatFeature} />
		</div>
	);
}

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
	return (
		<>
			<dt>{label}</dt>
			<dd className={cn("text-right", strong ? "font-semibold text-neutral-900" : "text-neutral-700")}>{value}</dd>
		</>
	);
}

function TooltipBreakdown({
	title,
	rows,
	metric,
	label,
}: {
	title: string;
	rows: UsageBreakdownRow[];
	metric: UsageMetric;
	label: (key: string) => string;
}) {
	if (!rows.length) return null;
	const { shown, more } = topRows(rows, metric);
	return (
		<div className="mt-2 border-t border-neutral-200 pt-2">
			<p className="font-medium text-neutral-900">{title}</p>
			<ul className="mt-1 space-y-0.5">
				{shown.map((row) => (
					<li key={row.key} className="flex justify-between gap-3">
						<span className="min-w-0 truncate">{label(row.key)}</span>
						<span className="shrink-0 tabular-nums text-neutral-700">
							{formatTokenCount(row.requests)} req · {formatCompact(row.inputTokens + row.outputTokens)} tok
							{" · "}
							{formatEstimatedUsd(totalCostMicros(row))}
						</span>
					</li>
				))}
			</ul>
			{more > 0 && <p className="mt-0.5 text-neutral-500">and {more} more</p>}
		</div>
	);
}
