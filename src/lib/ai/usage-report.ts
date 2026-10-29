import { getDb } from "@/db";
import { getAgentProviderConfig } from "@/lib/agent/provider";
import { builtinModelPrice, resolveAgentModelRates, routesVendorModelIds } from "@/lib/agent/model-prices-utils";
import { getAutoReadInstallSettings } from "@/lib/agent/auto-read/install-settings";
import { INTERACTIVE_SPEND_SOURCES, utcDayStartSeconds } from "@/lib/agent/auto-read/spend-utils";
import type { AgentModelRates } from "@/lib/agent/provider-types";
import type { SessionUser } from "@/lib/auth/types";
import { listAccessibleMailboxes } from "@/lib/mailboxes/access";
import { recentZonedDays } from "@/lib/time/utils";
import { aiUsageDetailsReady } from "./usage-details";
import type {
	UsageActivityPage,
	UsageActivityRow,
	UsageFilters,
	UsageQuery,
	UsageReport,
	UsageSpendToday,
} from "./usage-report-types";
import {
	STALE_RESERVATION_SECONDS,
	USAGE_PAGE_SIZE,
	buildUsageReport,
	dayBucketSql,
	estimateCostMicros,
	estimatedCostSql,
	isUsageRowStatus,
	usageStatusSql,
	type UsageGroupRow,
	type UsageMailboxGroupRow,
	type UsageRateLookup,
} from "./usage-report-utils";

type Bound = string | number;

/** Sums of a group; `estimated` is the SQL for a cost that is the reservation's estimate. */
const sumsSql = (estimated: string) => `count(*) AS requests,
	coalesce(sum(input_tokens), 0) AS inputTokens,
	coalesce(sum(output_tokens), 0) AS outputTokens,
	coalesce(sum(CASE WHEN ${estimated} THEN NULL ELSE cost_usd_micros END), 0) AS costUsdMicros,
	count(cost_usd_micros) AS pricedRequests,
	coalesce(sum(CASE WHEN ${estimated} THEN cost_usd_micros END), 0) AS estimatedStoredCostUsdMicros,
	count(CASE WHEN ${estimated} THEN cost_usd_micros END) AS estimatedStoredRequests,
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
	"estimatedStoredCostUsdMicros",
	"estimatedStoredRequests",
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

/**
 * Each model's current rates as a provider's requests resolve them, and where they come from: the admin's saved rate
 * first, then Kite's price list, where a router's `vendor/model` id takes the vendor's price.
 */
function currentRates(saved: Record<string, AgentModelRates>): UsageRateLookup {
	const cache = new Map<string, ReturnType<UsageRateLookup>>();
	return (provider, model) => {
		const key = `${provider}\u0000${model}`;
		let found = cache.get(key);
		if (!found) {
			const match = { vendorPrefixed: routesVendorModelIds(provider) };
			const own = saved[model];
			const source =
				own && own.input !== null && own.output !== null
					? "saved"
					: builtinModelPrice(model, undefined, undefined, match)
						? "price_list"
						: null;
			found = { rates: resolveAgentModelRates(saved, [model], undefined, undefined, match)[model], source };
			cache.set(key, found);
		}
		return found;
	};
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
	costEstimated: number;
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
	rateFor: UsageRateLookup,
	labels: ReadonlyMap<string, string>,
): UsageActivityRow {
	const current = rateFor(row.provider, row.model).rates;
	const estimated =
		row.costUsdMicros === null ? estimateCostMicros(current, row.inputTokens ?? 0, row.outputTokens ?? 0) : null;
	const recorded = row.inputRate !== null && row.outputRate !== null;
	// Which mailbox and job a request of someone else's private mailbox belonged to is not this admin's to see.
	const hidden = row.mailboxId !== null && !labels.has(row.mailboxId);
	return {
		id: row.id,
		createdAt: new Date(row.createdAt * 1000).toISOString(),
		provider: row.provider,
		model: row.model,
		source: row.source,
		inputTokens: row.inputTokens,
		outputTokens: row.outputTokens,
		costUsdMicros: row.costUsdMicros,
		costEstimated: row.costUsdMicros !== null && !!row.costEstimated,
		estimatedCostUsdMicros: estimated,
		mailboxId: hidden ? null : row.mailboxId,
		mailboxLabel: row.mailboxId ? (labels.get(row.mailboxId) ?? null) : null,
		jobId: hidden ? null : row.jobId,
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

/** What the range's SQL shares: its bounds, and the status and estimate expressions for this schema. */
async function rangeSql(env: CloudflareEnv, query: UsageQuery, timeZone: string) {
	const days = recentZonedDays(timeZone, query.range);
	const detailsRecorded = await aiUsageDetailsReady(env);
	const staleBefore = Math.floor(Date.now() / 1000) - STALE_RESERVATION_SECONDS;
	return {
		days,
		from: Math.floor(days[0].start.getTime() / 1000),
		to: Math.floor(days[days.length - 1].end.getTime() / 1000),
		detailsRecorded,
		statusSql: usageStatusSql(detailsRecorded, staleBefore),
		estimatedSql: estimatedCostSql(detailsRecorded),
		where: "created_at >= ? AND created_at < ?",
	};
}

/** The activity page alone: one count and one page of rows, both on `ai_usage_created_idx`. */
export async function loadUsageActivity(
	env: CloudflareEnv,
	user: SessionUser,
	query: UsageQuery,
	timeZone: string,
	context?: {
		sql: Awaited<ReturnType<typeof rangeSql>>;
		labels: ReadonlyMap<string, string>;
		rateFor: UsageRateLookup;
	},
): Promise<UsageActivityPage> {
	const sql = context?.sql ?? (await rangeSql(env, query, timeZone));
	const [labels, rateFor] = context
		? [context.labels, context.rateFor]
		: await Promise.all([
				mailboxLabels(env, user),
				getAgentProviderConfig(env).then((config) => currentRates(config.rates)),
			]);
	const filter = filterSql(query.filters, sql.statusSql);
	const detailSql = sql.detailsRecorded
		? "error_code AS errorCode, duration_ms AS durationMs, finish_reason AS finishReason, input_rate AS inputRate, output_rate AS outputRate"
		: "NULL AS errorCode, NULL AS durationMs, NULL AS finishReason, NULL AS inputRate, NULL AS outputRate";
	const [[count], rows] = await Promise.all([
		all<{ total: number }>(env, `SELECT count(*) AS total FROM ai_usage WHERE ${sql.where}${filter.where}`, [
			sql.from,
			sql.to,
			...filter.values,
		]),
		all<ActivityDbRow>(
			env,
			`SELECT id, created_at AS createdAt, provider, model, source, input_tokens AS inputTokens,
				output_tokens AS outputTokens, cost_usd_micros AS costUsdMicros, ${sql.estimatedSql} AS costEstimated,
				mailbox_id AS mailboxId, job_id AS jobId, reserved, ${sql.statusSql} AS status, ${detailSql}
			FROM ai_usage WHERE ${sql.where}${filter.where}
			ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
			[sql.from, sql.to, ...filter.values, USAGE_PAGE_SIZE, (query.page - 1) * USAGE_PAGE_SIZE],
		),
	]);
	const totalRows = Number(count?.total ?? 0);
	return {
		range: query.range,
		timeZone,
		detailsRecorded: sql.detailsRecorded,
		filters: query.filters,
		rows: rows.map((row) => activityRow(row, rateFor, labels)),
		page: query.page,
		pageSize: USAGE_PAGE_SIZE,
		totalPages: Math.max(1, Math.ceil(totalRows / USAGE_PAGE_SIZE)),
		totalRows,
	};
}

/** Addresses of the mailboxes `user` can open. */
async function mailboxLabels(env: CloudflareEnv, user: SessionUser): Promise<Map<string, string>> {
	const mailboxes = await listAccessibleMailboxes(getDb(env), user);
	return new Map(mailboxes.map((mailbox) => [mailbox.id, `${mailbox.localPart}@${mailbox.hostname}`]));
}

/**
 * Admin → AI usage for `query.range` days in `timeZone`. Two grouped scans of the range (by day, model, provider,
 * feature and status, and by mailbox, provider and model) feed every total, chart day and breakdown; the activity
 * page is one more indexed query. All of them use `ai_usage_created_idx`.
 */
export async function loadUsageReport(
	env: CloudflareEnv,
	user: SessionUser,
	query: UsageQuery,
	timeZone: string,
): Promise<UsageReport> {
	const sql = await rangeSql(env, query, timeZone);
	const sums = sumsSql(sql.estimatedSql);
	const errorSql = sql.detailsRecorded ? "error_code" : "NULL";
	const [groupRows, mailboxRows, config, install, labels] = await Promise.all([
		all<UsageGroupRow>(
			env,
			`SELECT ${dayBucketSql(sql.days)} AS date, model, provider, source, ${sql.statusSql} AS status,
				${errorSql} AS errorCode, ${sums}
			FROM ai_usage WHERE ${sql.where} GROUP BY 1, 2, 3, 4, 5, 6`,
			[sql.from, sql.to],
		),
		all<UsageMailboxGroupRow>(
			env,
			`SELECT mailbox_id AS mailboxId, provider, model, ${sums},
				sum(CASE WHEN (${sql.statusSql}) = 'failed' THEN 1 ELSE 0 END) AS failedRequests
			FROM ai_usage WHERE ${sql.where} GROUP BY 1, 2, 3`,
			[sql.from, sql.to],
		),
		getAgentProviderConfig(env),
		getAutoReadInstallSettings(env),
		mailboxLabels(env, user),
	]);
	const groups = groupRows.map((row) => {
		const parsed = numbers(row, SUM_KEYS);
		return { ...parsed, status: isUsageRowStatus(row.status) ? row.status : "unrecorded" };
	});
	const mailboxGroups = mailboxRows.map((row) => numbers(row, [...SUM_KEYS, "failedRequests"]));
	const rateFor = currentRates(config.rates);
	const report = buildUsageReport({
		days: sql.days,
		groups,
		mailboxGroups,
		rateFor,
		configuredModels: config.models,
		mailboxLabels: labels,
	});
	const [activity, today] = await Promise.all([
		loadUsageActivity(env, user, query, timeZone, { sql, labels, rateFor }),
		spendToday(env, labels, install),
	]);
	return { ...activity, ...report, spendToday: today };
}
