import { authFetch } from "@/lib/auth/client";
import { AI_FEATURE_LABELS } from "@/lib/agent/ai-error-utils";
import { formatUserDate } from "@/lib/time/utils";
import type {
	UsageActivityPage,
	UsageFilters,
	UsageRange,
	UsageReport,
	UsageRowStatus,
	UsageSums,
} from "@/lib/ai/usage-report-types";
import type { UsageMetric } from "./types";

/** The whole report, or with `activityOnly` just the activity page for a filter or page change. */
export async function fetchAiUsage(
	range: UsageRange,
	page: number,
	filters: UsageFilters,
	activityOnly = false,
): Promise<UsageReport | UsageActivityPage> {
	const params = new URLSearchParams({ range: String(range), page: String(page) });
	if (activityOnly) params.set("part", "activity");
	for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
	const response = await authFetch(`/api/admin/ai-usage?${params}`);
	const data = (await response.json()) as UsageReport & { error?: string };
	if (!response.ok) throw new Error(data.error || "Could not load AI usage");
	return data;
}

export function formatTokenCount(value: number | null) {
	return value === null ? "—" : new Intl.NumberFormat().format(value);
}

/** 1.2K, 3.4M: for axis labels and tight cells. */
export function formatCompact(value: number) {
	return new Intl.NumberFormat(undefined, { notation: "compact", maximumSignificantDigits: 3 }).format(value);
}

/** Dollars with cents, or up to four decimals under a cent, so small costs neither vanish nor sprawl. */
export function formatEstimatedUsd(micros: number | null) {
	if (micros === null) return "—";
	const dollars = micros / 1_000_000;
	if (dollars > 0 && dollars < 0.0001) return "<$0.0001";
	const small = dollars > 0 && dollars < 0.01;
	return `$${dollars.toLocaleString(undefined, { minimumFractionDigits: small ? 4 : 2, maximumFractionDigits: small ? 4 : 2 })}`;
}

/** USD per 1M tokens, as Admin → Agent writes rates. */
export function formatRate(rate: { input: number; output: number }) {
	const usd = (value: number) => `$${value.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
	return `${usd(rate.input)} in / ${usd(rate.output)} out per 1M tokens`;
}

export function formatPercent(part: number, whole: number) {
	if (!whole) return "0%";
	const share = (part / whole) * 100;
	return `${share > 0 && share < 1 ? "<1" : Math.round(share)}%`;
}

export function formatDuration(ms: number | null) {
	if (ms === null) return "Not recorded";
	return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} s`;
}

export function formatUsageDate(value: string) {
	return formatUserDate(value, { dateStyle: "medium", timeStyle: "short" });
}

export function formatUsageProvider(value: string) {
	return (
		(
			{
				cloudflare: "Cloudflare Workers AI",
				haimaker: "Haimaker.ai",
				anthropic: "Anthropic",
				openai: "OpenAI",
				openrouter: "OpenRouter",
				groq: "Groq",
				custom: "Custom API",
			} as Record<string, string>
		)[value] ?? value
	);
}

const FEATURE_LABELS: Record<string, string> = {
	...AI_FEATURE_LABELS,
	auto_triage: "Automatic reading",
	auto_triage_line: "Automatic reading with list line",
};

export function formatFeature(source: string) {
	return FEATURE_LABELS[source] ?? source;
}

export const STATUS_LABELS: Record<UsageRowStatus, string> = {
	ok: "Succeeded",
	failed: "Failed",
	stopped: "Stopped",
	running: "Running",
	interrupted: "Interrupted",
	unrecorded: "Not recorded",
};

const ERROR_LABELS: Record<string, string> = {
	timeout: "Timed out",
	cut_off: "Cut off: hit the output limit; tokens still counted",
	provider_rejected: "Provider refused",
	provider_auth: "API key not accepted",
	provider_unavailable: "Provider unavailable",
	provider_error: "Provider error",
	provider_rate_limited: "Provider rate limit",
	model_unavailable: "Model unavailable",
	context_too_long: "Too long for the model",
	unusable_answer: "Unusable answer",
	spend_cap: "Spend cap reached",
	rate_limited: "Rate limited",
	external_provider_not_allowed: "External provider not allowed",
	assistant_off: "Assistant off",
	no_provider: "No provider",
	network: "Network error",
	internal: "Internal error",
};

export function formatErrorCode(code: string) {
	return ERROR_LABELS[code] ?? code;
}

/** Stored cost plus the estimate for rows that stored none. */
export function totalCostMicros(sums: Pick<UsageSums, "costUsdMicros" | "estimatedCostUsdMicros">) {
	return sums.costUsdMicros + sums.estimatedCostUsdMicros;
}

export function metricValue(sums: UsageSums, metric: UsageMetric) {
	if (metric === "cost") return totalCostMicros(sums);
	if (metric === "requests") return sums.requests;
	return sums.inputTokens + sums.outputTokens;
}

export function formatMetric(value: number, metric: UsageMetric) {
	return metric === "cost" ? formatEstimatedUsd(value) : formatTokenCount(value);
}

export const METRIC_LABELS: Record<UsageMetric, string> = { tokens: "Tokens", cost: "Cost", requests: "Requests" };

export function formatDailyLabel(value: string) {
	return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" }).format(
		new Date(`${value}T00:00:00Z`),
	);
}

export function formatDayHeading(value: string) {
	return new Intl.DateTimeFormat(undefined, {
		weekday: "short",
		month: "short",
		day: "numeric",
		timeZone: "UTC",
	}).format(new Date(`${value}T00:00:00Z`));
}
