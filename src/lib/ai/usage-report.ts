import { getDb } from "@/db";
import { getAgentProviderConfig } from "@/lib/agent/provider";
import { builtinModelPrice, resolveAgentModelRates } from "@/lib/agent/model-prices-utils";
import { getAutoReadInstallSettings } from "@/lib/agent/auto-read/install-settings";
import { INTERACTIVE_SPEND_SOURCES, utcDayStartSeconds } from "@/lib/agent/auto-read/spend-utils";
import type { AgentModelRates } from "@/lib/agent/provider-types";
import type { SessionUser } from "@/lib/auth/types";
import { listAccessibleMailboxes } from "@/lib/mailboxes/access";
import { recentZonedDays } from "@/lib/time/utils";
import { aiUsageDetailsReady } from "./usage-details";
import type { UsageActivityRow, UsageFilters, UsageQuery, UsageReport, UsageSpendToday } from "./usage-report-types";
import {
	USAGE_PAGE_SIZE,
	buildUsageReport,
	dayBucketSql,
	estimateCostMicros,
	isUsageRowStatus,
	usageStatusSql,
	type UsageGroupRow,
	type UsageMailboxGroupRow,
} from "./usage-report-utils";

type Bound = string | number;

const SUMS_SQL = `count(*) AS requests,
	coalesce(sum(input_tokens), 0) AS inputTokens,
	coalesce(sum(output_tokens), 0) AS outputTokens,
	coalesce(sum(cost_usd_micros), 0) AS costUsdMicros,
	count(cost_usd_micros) AS pricedRequests,
	coalesce(sum(CASE WHEN cost_usd_micros IS NULL THEN input_tokens END), 0) AS unpricedInputTokens,
	coalesce(sum(CASE WHEN cost_usd_micros IS NULL THEN output_tokens END), 0) AS unpricedOutputTokens`;

const INTERACTIVE_SQL = INTERACTIVE_SPEND_SOURCES.map((source) => `'${source}'`).join(", ");

async function all<T>(env: CloudflareEnv, query: string, values: Bound[]): Promise<T[]> {
	const result = await env.DB.prepare(query)
		.bind(...values)
		.all<T>();
	return result.results ?? [];
}

function numbers<T extends Record<string, unknown>>(row: T, keys: readonly (keyof T)[]): T {
	const copy = { ...row };
	for (const key of keys) copy[key] = Number(row[key] ?? 0) as T[keyof T];
	return copy;
}

const SUM_KEYS = [
	"requests",
	"inputTokens",
	"outputTokens",
	"costUsdMicros",
	"pricedRequests",
	"unpricedInputTokens",
	"unpricedOutputTokens",
] as const;

/** The activity filters as SQL conditions on the range query. */
function filterSql(filters: UsageFilters, statusSql: string): { where: string; values: Bound[] } {
	const parts: string[] = [];
	const values: Bound[] = [];
	const add = (condition: string, value: Bound | undefined) => {
		if (value === undefined) return;
		parts.push(condition);
		values.push(value);
	};
	add("model = ?", filters.model);
	add("provider = ?", filters.provider);
	add("source = ?", filters.feature);
	add(`(${statusSql}) = ?`, filters.status);
	return { where: parts.map((part) => ` AND ${part}`).join(""), values };
}

/** Each model's current rates and where they come from: the admin's saved rate first, then Kite's price list. */
function currentRates(saved: Record<string, AgentModelRates>, models: readonly string[]) {
	const rates = resolveAgentModelRates(saved, models);
	const sources: Record<string, "saved" | "price_list"> = {};
	for (const model of models) {
		const own = saved[model];
		if (own && own.input !== null && own.output !== null) sources[model] = "saved";
		else if (builtinModelPrice(model)) sources[model] = "price_list";
	}
	return { rates, sources };
}

async function spendToday(
	env: CloudflareEnv,
	labels: ReadonlyMap<string, string>,
	install: Awaited<ReturnType<typeof getAutoReadInstallSettings>>,
): Promise<UsageSpendToday> {
	const dayStart = utcDayStartSeconds(new Date());
	const [today] = await all<{ spent: number; chatTokens: number; autoReadTokens: number }>(
		env,
		`SELECT coalesce(sum(cost_usd_micros), 0) AS spent,
			coalesce(sum(CASE WHEN source IN (${INTERACTIVE_SQL}) THEN input_tokens END), 0) AS chatTokens,
			coalesce(sum(CASE WHEN source NOT IN (${INTERACTIVE_SQL}) THEN input_tokens END), 0) AS autoReadTokens
		FROM ai_usage WHERE created_at >= ?`,
		[dayStart],
	);
	const capped = await all<{ mailboxId: string; capMicros: number; spentMicros: number }>(
		env,
		`SELECT s.mailbox_id AS mailboxId, s.daily_spend_cap_micros AS capMicros,
			(SELECT coalesce(sum(u.cost_usd_micros), 0) FROM ai_usage u WHERE u.mailbox_id = s.mailbox_id AND u.created_at >= ?) AS spentMicros
		FROM mailbox_agent_settings s WHERE s.daily_spend_cap_micros IS NOT NULL`,
		[dayStart],
	);
	return {
		dayStart: new Date(dayStart * 1000).toISOString(),
		installCapMicros: install.dailySpendCapMicros,
		installSpentMicros: Number(today?.spent ?? 0),
		chatTokenCap: install.chatTokenCap,
		chatTokensUsed: Number(today?.chatTokens ?? 0),
		autoReadTokenCap: install.autoReadTokenCap,
		autoReadTokensUsed: Number(today?.autoReadTokens ?? 0),
		mailboxes: capped
			.filter((row) => labels.has(row.mailboxId))
			.map((row) => ({
				id: row.mailboxId,
				label: labels.get(row.mailboxId) as string,
				capMicros: Number(row.capMicros),
				spentMicros: Number(row.spentMicros),
			}))
			.sort((a, b) => a.label.localeCompare(b.label)),
	};
}

type ActivityDbRow = {
	id: string;
	createdAt: number;
	provider: string;
	model: string;
	source: string;
	inputTokens: number | null;
	outputTokens: number | null;
	costUsdMicros: number | null;
	mailboxId: string | null;
	jobId: string | null;
	reserved: number;
	status: string;
	errorCode: string | null;
	durationMs: number | null;
	finishReason: string | null;
	inputRate: number | null;
	outputRate: number | null;
};

function activityRow(
	row: ActivityDbRow,
	rates: Record<string, AgentModelRates>,
	labels: ReadonlyMap<string, string>,
): UsageActivityRow {
	const current = rates[row.model];
	const estimated =
		row.costUsdMicros === null ? estimateCostMicros(current, row.inputTokens ?? 0, row.outputTokens ?? 0) : null;
	const recorded = row.inputRate !== null && row.outputRate !== null;
	return {
		id: row.id,
		createdAt: new Date(row.createdAt * 1000).toISOString(),
		provider: row.provider,
		model: row.model,
		source: row.source,
		inputTokens: row.inputTokens,
		outputTokens: row.outputTokens,
		costUsdMicros: row.costUsdMicros,
		estimatedCostUsdMicros: estimated,
		mailboxId: row.mailboxId,
		mailboxLabel: row.mailboxId ? (labels.get(row.mailboxId) ?? null) : null,
		jobId: row.jobId,
		reserved: !!row.reserved,
		status: isUsageRowStatus(row.status) ? row.status : "unrecorded",
		errorCode: row.errorCode,
		durationMs: row.durationMs,
		finishReason: row.finishReason,
		rate: recorded
			? { input: Number(row.inputRate), output: Number(row.outputRate), kind: "recorded" }
			: estimated !== null && current?.input != null && current.output != null
				? { input: current.input, output: current.output, kind: "current" }
				: null,
	};
}

/**
 * Admin → AI usage for `query.range` days in `timeZone`. Two grouped scans of the range (by day, model, provider,
 * feature and status, and by mailbox and model) feed every total, chart day and breakdown; the activity page is one
 * more indexed query. All of them use `ai_usage_created_idx`.
 */
export async function loadUsageReport(
	env: CloudflareEnv,
	user: SessionUser,
	query: UsageQuery,
	timeZone: string,
): Promise<UsageReport> {
	const days = recentZonedDays(timeZone, query.range);
	const from = Math.floor(days[0].start.getTime() / 1000);
	const to = Math.floor(days[days.length - 1].end.getTime() / 1000);
	const detailsRecorded = await aiUsageDetailsReady(env);
	const statusSql = usageStatusSql(detailsRecorded);
	const errorSql = detailsRecorded ? "error_code" : "NULL";
	const range = "created_at >= ? AND created_at < ?";

	const [groupRows, mailboxRows, config, install, mailboxes] = await Promise.all([
		all<UsageGroupRow>(
			env,
			`SELECT ${dayBucketSql(days)} AS date, model, provider, source, ${statusSql} AS status, ${errorSql} AS errorCode,
				${SUMS_SQL}
			FROM ai_usage WHERE ${range} GROUP BY 1, 2, 3, 4, 5, 6`,
			[from, to],
		),
		all<UsageMailboxGroupRow>(
			env,
			`SELECT mailbox_id AS mailboxId, model, ${SUMS_SQL},
				sum(CASE WHEN (${statusSql}) = 'failed' THEN 1 ELSE 0 END) AS failedRequests
			FROM ai_usage WHERE ${range} GROUP BY 1, 2`,
			[from, to],
		),
		getAgentProviderConfig(env),
		getAutoReadInstallSettings(env),
		listAccessibleMailboxes(getDb(env), user),
	]);
	const groups = groupRows.map((row) => {
		const parsed = numbers(row, SUM_KEYS);
		return { ...parsed, status: isUsageRowStatus(row.status) ? row.status : "unrecorded" };
	});
	const mailboxGroups = mailboxRows.map((row) => numbers(row, [...SUM_KEYS, "failedRequests"]));
	const labels = new Map(mailboxes.map((mailbox) => [mailbox.id, `${mailbox.localPart}@${mailbox.hostname}`]));
	const models = [...new Set([...config.models, ...groups.map((group) => group.model)])];
	const { rates, sources } = currentRates(config.rates, models);
	const report = buildUsageReport({
		days,
		groups,
		mailboxGroups,
		rates,
		rateSources: sources,
		configuredModels: config.models,
		mailboxLabels: labels,
	});

	const filter = filterSql(query.filters, statusSql);
	const detailSql = detailsRecorded
		? "error_code AS errorCode, duration_ms AS durationMs, finish_reason AS finishReason, input_rate AS inputRate, output_rate AS outputRate"
		: "NULL AS errorCode, NULL AS durationMs, NULL AS finishReason, NULL AS inputRate, NULL AS outputRate";
	const [[count], rows, today] = await Promise.all([
		all<{ total: number }>(env, `SELECT count(*) AS total FROM ai_usage WHERE ${range}${filter.where}`, [
			from,
			to,
			...filter.values,
		]),
		all<ActivityDbRow>(
			env,
			`SELECT id, created_at AS createdAt, provider, model, source, input_tokens AS inputTokens,
				output_tokens AS outputTokens, cost_usd_micros AS costUsdMicros, mailbox_id AS mailboxId, job_id AS jobId,
				reserved, ${statusSql} AS status, ${detailSql}
			FROM ai_usage WHERE ${range}${filter.where}
			ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
			[from, to, ...filter.values, USAGE_PAGE_SIZE, (query.page - 1) * USAGE_PAGE_SIZE],
		),
		spendToday(env, labels, install),
	]);
	const totalRows = Number(count?.total ?? 0);
	return {
		range: query.range,
		timeZone,
		detailsRecorded,
		...report,
		spendToday: today,
		filters: query.filters,
		rows: rows.map((row) => activityRow(row, rates, labels)),
		page: query.page,
		pageSize: USAGE_PAGE_SIZE,
		totalPages: Math.max(1, Math.ceil(totalRows / USAGE_PAGE_SIZE)),
		totalRows,
	};
}
