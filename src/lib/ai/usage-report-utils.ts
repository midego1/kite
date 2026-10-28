import type { AgentModelRates } from "@/lib/agent/provider-types";
import type {
	UsageBreakdownRow,
	UsageBreakdowns,
	UsageDay,
	UsageFilters,
	UsageMissingRate,
	UsageQuery,
	UsageRange,
	UsageRowStatus,
	UsageSums,
} from "./usage-report-types";

const USAGE_RANGES: readonly UsageRange[] = [7, 30, 90];
export const DEFAULT_USAGE_RANGE: UsageRange = 30;
export const USAGE_PAGE_SIZE = 20;
const USAGE_STATUSES: readonly UsageRowStatus[] = ["ok", "failed", "stopped", "running", "unrecorded"];
const MAX_FILTER_LENGTH = 200;

/** One group of the range query: requests of one day, model, provider, feature, status and error code. */
export type UsageGroupRow = {
	date: string | null;
	model: string;
	provider: string;
	source: string;
	status: UsageRowStatus;
	errorCode: string | null;
	requests: number;
	inputTokens: number;
	outputTokens: number;
	costUsdMicros: number;
	pricedRequests: number;
	unpricedInputTokens: number;
	unpricedOutputTokens: number;
};

/** One group of the mailbox query: requests of one mailbox and model. */
export type UsageMailboxGroupRow = Omit<UsageGroupRow, "date" | "provider" | "source" | "status" | "errorCode"> & {
	mailboxId: string | null;
	failedRequests: number;
};

export function isUsageRowStatus(value: unknown): value is UsageRowStatus {
	return typeof value === "string" && (USAGE_STATUSES as readonly string[]).includes(value);
}

/** The page, range and activity filters of `GET /api/admin/ai-usage`, or the error for a bad one. */
export function parseUsageQuery(params: URLSearchParams): UsageQuery | { error: string } {
	const range = Number(params.get("range") ?? DEFAULT_USAGE_RANGE);
	if (!(USAGE_RANGES as readonly number[]).includes(range)) return { error: "Invalid range" };
	const page = Number(params.get("page") ?? "1");
	if (!Number.isSafeInteger(page) || page < 1 || page > Math.floor(Number.MAX_SAFE_INTEGER / USAGE_PAGE_SIZE))
		return { error: "Invalid page" };
	const filters: UsageFilters = {};
	for (const key of ["model", "provider", "feature"] as const) {
		const value = params.get(key);
		if (!value) continue;
		if (value.length > MAX_FILTER_LENGTH) return { error: `Invalid ${key}` };
		filters[key] = value;
	}
	const status = params.get("status");
	if (status) {
		if (!isUsageRowStatus(status)) return { error: "Invalid status" };
		filters.status = status;
	}
	return { range: range as UsageRange, page, filters };
}

/** USD micros for `input` and `output` tokens at a model's base rates, or null without both rates. */
export function estimateCostMicros(
	rates: Pick<AgentModelRates, "input" | "output"> | undefined,
	inputTokens: number,
	outputTokens: number,
): number | null {
	if (!rates || rates.input === null || rates.output === null) return null;
	return Math.round(inputTokens * rates.input + outputTokens * rates.output);
}

function emptyUsageSums(): UsageSums {
	return {
		requests: 0,
		inputTokens: 0,
		outputTokens: 0,
		costUsdMicros: 0,
		pricedRequests: 0,
		estimatedCostUsdMicros: 0,
		estimatedRequests: 0,
		unratedRequests: 0,
		failedRequests: 0,
	};
}

type GroupSums = Pick<
	UsageGroupRow,
	| "model"
	| "requests"
	| "inputTokens"
	| "outputTokens"
	| "costUsdMicros"
	| "pricedRequests"
	| "unpricedInputTokens"
	| "unpricedOutputTokens"
> & { failedRequests: number };

/**
 * Adds a group to `sums`. Rows that stored no cost (before Kite knew the model's price, or a model without one) are
 * priced at the model's current rate; long-context tiers are not applied to these estimates.
 */
function addGroup(sums: UsageSums, group: GroupSums, rates: Record<string, AgentModelRates>) {
	const unpriced = group.requests - group.pricedRequests;
	sums.requests += group.requests;
	sums.inputTokens += group.inputTokens;
	sums.outputTokens += group.outputTokens;
	sums.costUsdMicros += group.costUsdMicros;
	sums.pricedRequests += group.pricedRequests;
	sums.failedRequests += group.failedRequests;
	if (unpriced <= 0) return;
	const estimate = estimateCostMicros(rates[group.model], group.unpricedInputTokens, group.unpricedOutputTokens);
	if (estimate === null) sums.unratedRequests += unpriced;
	else {
		sums.estimatedCostUsdMicros += estimate;
		sums.estimatedRequests += unpriced;
	}
}

class SumsByKey {
	private readonly sums = new Map<string, UsageSums>();
	add(key: string, group: GroupSums, rates: Record<string, AgentModelRates>) {
		let sums = this.sums.get(key);
		if (!sums) this.sums.set(key, (sums = emptyUsageSums()));
		addGroup(sums, group, rates);
	}
	/** Largest first by tokens, then requests, then key. */
	rows(): UsageBreakdownRow[] {
		return [...this.sums]
			.map(([key, sums]) => ({ key, ...sums }))
			.sort(
				(a, b) =>
					b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens) ||
					b.requests - a.requests ||
					a.key.localeCompare(b.key),
			);
	}
}

export type BuildUsageReportInput = {
	days: readonly { date: string }[];
	groups: readonly UsageGroupRow[];
	mailboxGroups: readonly UsageMailboxGroupRow[];
	/** Each model's current rates (saved, then Kite's price list). */
	rates: Record<string, AgentModelRates>;
	/** Where each model's current rate comes from. */
	rateSources: Record<string, "saved" | "price_list">;
	/** The models in Admin → Agent's list. */
	configuredModels: readonly string[];
	/** Addresses of the mailboxes the admin can open. */
	mailboxLabels: ReadonlyMap<string, string>;
};

/** Totals, days, breakdowns, statuses, error codes and models without a rate, from the grouped range queries. */
export function buildUsageReport(input: BuildUsageReportInput) {
	const { rates } = input;
	const totals = emptyUsageSums();
	const days = new Map(
		input.days.map(({ date }) => [
			date,
			{ sums: emptyUsageSums(), models: new SumsByKey(), features: new SumsByKey() },
		]),
	);
	const model = new SumsByKey();
	const provider = new SumsByKey();
	const feature = new SumsByKey();
	const statuses = new Map<UsageRowStatus, number>();
	const errorCodes = new Map<string, number>();
	const missing = new Map<string, UsageMissingRate>();
	for (const group of input.groups) {
		const sums: GroupSums = { ...group, failedRequests: group.status === "failed" ? group.requests : 0 };
		addGroup(totals, sums, rates);
		const day = group.date ? days.get(group.date) : undefined;
		if (day) {
			addGroup(day.sums, sums, rates);
			day.models.add(group.model, sums, rates);
			day.features.add(group.source, sums, rates);
		}
		model.add(group.model, sums, rates);
		provider.add(group.provider, sums, rates);
		feature.add(group.source, sums, rates);
		statuses.set(group.status, (statuses.get(group.status) ?? 0) + group.requests);
		if (group.status === "failed" && group.errorCode)
			errorCodes.set(group.errorCode, (errorCodes.get(group.errorCode) ?? 0) + group.requests);
		const unpriced = group.requests - group.pricedRequests;
		if (unpriced > 0) {
			const key = `${group.provider}\u0000${group.model}`;
			const entry = missing.get(key);
			if (entry) entry.requests += unpriced;
			else {
				const rate = rates[group.model];
				const known = rate && rate.input !== null && rate.output !== null;
				missing.set(key, {
					model: group.model,
					provider: group.provider,
					requests: unpriced,
					rate: known ? { input: rate.input as number, output: rate.output as number } : null,
					rateSource: known ? (input.rateSources[group.model] ?? null) : null,
					configured: input.configuredModels.includes(group.model),
				});
			}
		}
	}
	const mailbox = new SumsByKey();
	for (const group of input.mailboxGroups) {
		const key =
			group.mailboxId === null ? "none" : input.mailboxLabels.has(group.mailboxId) ? group.mailboxId : "other";
		mailbox.add(key, group, rates);
	}
	const daily: UsageDay[] = [...days].map(([date, day]) => ({
		date,
		...day.sums,
		models: day.models.rows(),
		features: day.features.rows(),
	}));
	const breakdowns: UsageBreakdowns = {
		model: model.rows(),
		provider: provider.rows(),
		feature: feature.rows(),
		mailbox: mailbox.rows().map((row) => ({ ...row, label: mailboxLabel(row.key, input.mailboxLabels) })),
	};
	return {
		totals: { ...totals, totalTokens: totals.inputTokens + totals.outputTokens },
		daily,
		breakdowns,
		statuses: USAGE_STATUSES.flatMap((status) => {
			const requests = statuses.get(status) ?? 0;
			return requests ? [{ status, requests }] : [];
		}),
		errorCodes: [...errorCodes]
			.map(([code, requests]) => ({ code, requests }))
			.sort((a, b) => b.requests - a.requests || a.code.localeCompare(b.code)),
		// Models with no rate at all first: those are the ones to act on.
		missingRates: [...missing.values()].sort(
			(a, b) => Number(!!a.rate) - Number(!!b.rate) || b.requests - a.requests || a.model.localeCompare(b.model),
		),
		filterOptions: {
			models: sortedKeys(model.rows()),
			providers: sortedKeys(provider.rows()),
			features: sortedKeys(feature.rows()),
			statuses: USAGE_STATUSES.filter((status) => statuses.has(status)),
		},
	};
}

function sortedKeys(rows: UsageBreakdownRow[]): string[] {
	return rows.map((row) => row.key).sort((a, b) => a.localeCompare(b));
}

function mailboxLabel(key: string, labels: ReadonlyMap<string, string>): string {
	if (key === "none") return "No mailbox";
	if (key === "other") return "Other mailboxes";
	return labels.get(key) ?? key;
}

/** `CASE WHEN created_at < <end> THEN '<date>' … END` with literal values, so a 90-day range binds no parameters. */
export function dayBucketSql(days: readonly { date: string; end: Date }[], column = "created_at"): string {
	const branches = days.map(({ date, end }) => {
		const seconds = Math.floor(end.getTime() / 1000);
		if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isSafeInteger(seconds)) throw new Error("Invalid day");
		return `WHEN ${column} < ${seconds} THEN '${date}'`;
	});
	return `CASE ${branches.join(" ")} END`;
}

/** The status the page shows, as SQL; without migration 0078 every settled row is `unrecorded`. */
export function usageStatusSql(detailsRecorded: boolean): string {
	return detailsRecorded
		? "CASE WHEN reserved = 1 THEN 'running' WHEN status IS NULL THEN 'unrecorded' ELSE status END"
		: "CASE WHEN reserved = 1 THEN 'running' ELSE 'unrecorded' END";
}
