/** The days Admin → AI usage can show. */
export type UsageRange = 7 | 30 | 90;

/**
 * How a request ended, as the page shows it: the recorded status, `running` while its reservation is open, and
 * `unrecorded` for rows from before migration 0077.
 */
export type UsageRowStatus = "ok" | "failed" | "stopped" | "running" | "unrecorded";

export type UsageFilters = { model?: string; provider?: string; feature?: string; status?: UsageRowStatus };

export type UsageQuery = { range: UsageRange; page: number; filters: UsageFilters };

/** Sums over a set of requests. Costs are USD micros; `estimatedCostUsdMicros` prices rows that stored no cost. */
export type UsageSums = {
	requests: number;
	inputTokens: number;
	outputTokens: number;
	/** The cost stored with the rows. */
	costUsdMicros: number;
	/** Requests that stored a cost. */
	pricedRequests: number;
	/** Rows without a stored cost, priced at the model's current rate. */
	estimatedCostUsdMicros: number;
	/** Rows without a stored cost whose model has a rate now. */
	estimatedRequests: number;
	/** Rows without a stored cost whose model still has no rate. */
	unratedRequests: number;
	failedRequests: number;
};

export type UsageBreakdownRow = UsageSums & { key: string };

export type UsageBreakdowns = {
	model: UsageBreakdownRow[];
	provider: UsageBreakdownRow[];
	feature: UsageBreakdownRow[];
	/** Keyed by mailbox id; `other` for mailboxes the admin cannot open, `none` for requests without a mailbox. */
	mailbox: (UsageBreakdownRow & { label: string })[];
};

export type UsageDay = UsageSums & { date: string; models: UsageBreakdownRow[]; features: UsageBreakdownRow[] };

/** A model whose requests stored no cost, and whether it has a rate now. */
export type UsageMissingRate = {
	model: string;
	provider: string;
	requests: number;
	/** The rate the page estimates with: the admin's, or Kite's price list. */
	rate: { input: number; output: number } | null;
	rateSource: "saved" | "price_list" | null;
	/** Whether the model is in Admin → Agent's model list, where a rate can be set. */
	configured: boolean;
};

export type UsageSpendToday = {
	/** Start of the UTC day the caps count from (ISO). */
	dayStart: string;
	installCapMicros: number;
	installSpentMicros: number;
	chatTokenCap: number;
	chatTokensUsed: number;
	autoReadTokenCap: number;
	autoReadTokensUsed: number;
	/** Mailboxes the admin can open that have their own cap. */
	mailboxes: { id: string; label: string; capMicros: number; spentMicros: number }[];
};

export type UsageActivityRow = {
	id: string;
	createdAt: string;
	provider: string;
	model: string;
	source: string;
	inputTokens: number | null;
	outputTokens: number | null;
	costUsdMicros: number | null;
	/** The cost at the model's current rate, for a row that stored none. */
	estimatedCostUsdMicros: number | null;
	mailboxId: string | null;
	/** The mailbox's address, only for a mailbox the admin can open. */
	mailboxLabel: string | null;
	jobId: string | null;
	reserved: boolean;
	status: UsageRowStatus;
	errorCode: string | null;
	durationMs: number | null;
	finishReason: string | null;
	/** USD per 1M tokens: what the cost was counted at (`recorded`), or today's rate for an estimate (`current`). */
	rate: { input: number; output: number; kind: "recorded" | "current" } | null;
};

export type UsageReport = {
	range: UsageRange;
	timeZone: string;
	/** False until migration 0077: statuses, durations, finish reasons and rates are not recorded yet. */
	detailsRecorded: boolean;
	totals: UsageSums & { totalTokens: number };
	daily: UsageDay[];
	breakdowns: UsageBreakdowns;
	statuses: { status: UsageRowStatus; requests: number }[];
	errorCodes: { code: string; requests: number }[];
	missingRates: UsageMissingRate[];
	spendToday: UsageSpendToday;
	filterOptions: { models: string[]; providers: string[]; features: string[]; statuses: UsageRowStatus[] };
	filters: UsageFilters;
	rows: UsageActivityRow[];
	page: number;
	pageSize: number;
	totalPages: number;
	/** Rows matching the filters. */
	totalRows: number;
};
