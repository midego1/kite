import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import {
	buildUsageReport,
	dayBucketSql,
	estimateCostMicros,
	parseUsageQuery,
	usageStatusSql,
} from "../src/lib/ai/usage-report-utils.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-ai-usage-report-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		report: fileURLToPath(import.meta.resolve("../src/lib/ai/usage-report.ts")),
		chart: fileURLToPath(import.meta.resolve("../src/app/(admin)/ai-usage/chart-utils.ts")),
		runtime: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	packages: "external",
	tsconfig: join(root, "tsconfig.json"),
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { loadUsageReport } = await load("report");
const { axisLabelEvery, chartParts, tooltipLeft, topRows } = await load("chart");
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");

const group = (overrides) => ({
	date: "2026-10-27",
	model: "claude-opus-5-5",
	provider: "anthropic",
	source: "chat",
	status: "ok",
	errorCode: null,
	requests: 1,
	inputTokens: 0,
	outputTokens: 0,
	costUsdMicros: 0,
	pricedRequests: 0,
	unpricedInputTokens: 0,
	unpricedOutputTokens: 0,
	...overrides,
});

test("parseUsageQuery accepts the three ranges, a page and the activity filters, and refuses anything else", () => {
	assert.deepEqual(parseUsageQuery(new URLSearchParams()), { range: 30, page: 1, filters: {} });
	assert.deepEqual(
		parseUsageQuery(new URLSearchParams("range=90&page=3&model=m&provider=p&feature=chat&status=failed")),
		{ range: 90, page: 3, filters: { model: "m", provider: "p", feature: "chat", status: "failed" } },
	);
	for (const bad of ["range=14", "range=abc", "page=0", "page=1.5", "status=done", `model=${"x".repeat(201)}`])
		assert.ok("error" in parseUsageQuery(new URLSearchParams(bad)), bad);
});

test("estimateCostMicros needs both rates and counts USD per 1M tokens as micros per token", () => {
	assert.equal(estimateCostMicros({ input: 4, output: 20 }, 1_000, 100), 6_000);
	assert.equal(estimateCostMicros({ input: 4, output: null }, 1_000, 100), null);
	assert.equal(estimateCostMicros(undefined, 1_000, 100), null);
});

test("dayBucketSql writes literal boundaries, so 90 days bind no parameters, and refuses anything but dates", () => {
	const sql = dayBucketSql([
		{ date: "2026-10-27", end: new Date("2026-10-28T00:00:00Z") },
		{ date: "2026-10-28", end: new Date("2026-10-29T00:00:00Z") },
	]);
	assert.equal(
		sql,
		"CASE WHEN created_at < 1793145600 THEN '2026-10-27' WHEN created_at < 1793232000 THEN '2026-10-28' END",
	);
	assert.throws(() => dayBucketSql([{ date: "2026-10-27' OR 1=1 --", end: new Date() }]));
	assert.match(usageStatusSql(false), /'unrecorded'/);
	assert.match(usageStatusSql(true), /status IS NULL/);
});

test("buildUsageReport sums days, breakdowns, statuses and error codes, and estimates rows without a stored cost", () => {
	const report = buildUsageReport({
		days: [{ date: "2026-10-27" }, { date: "2026-10-28" }],
		groups: [
			// Priced when it ran.
			group({ requests: 2, inputTokens: 1_000, outputTokens: 100, costUsdMicros: 6_000, pricedRequests: 2 }),
			// Before Kite knew Opus 5.5's price: estimated at today's $4 / $20.
			group({
				date: "2026-10-28",
				source: "auto_triage",
				status: "unrecorded",
				requests: 3,
				inputTokens: 2_000,
				outputTokens: 200,
				unpricedInputTokens: 2_000,
				unpricedOutputTokens: 200,
			}),
			// A model nobody has a rate for.
			group({
				date: "2026-10-28",
				model: "mystery",
				provider: "custom",
				status: "failed",
				errorCode: "timeout",
				requests: 4,
				inputTokens: 500,
				unpricedInputTokens: 500,
			}),
			// Outside the days shown (a range edge): counted in the totals, not on a day.
			group({ date: null, requests: 1, inputTokens: 10, costUsdMicros: 40, pricedRequests: 1 }),
		],
		mailboxGroups: [
			{ mailboxId: "mine", model: "claude-opus-5-5", ...sums(2, 1_000, 100, 6_000, 2), failedRequests: 0 },
			{ mailboxId: "hidden", model: "mystery", ...sums(4, 500, 0, 0, 0, 500), failedRequests: 4 },
			{ mailboxId: null, model: "claude-opus-5-5", ...sums(3, 2_000, 200, 0, 0, 2_000, 200), failedRequests: 0 },
		],
		rates: { "claude-opus-5-5": { input: 4, output: 20 } },
		rateSources: { "claude-opus-5-5": "price_list" },
		configuredModels: ["claude-opus-5-5", "mystery"],
		mailboxLabels: new Map([["mine", "me@example.com"]]),
	});
	assert.deepEqual(report.totals, {
		requests: 10,
		inputTokens: 3_510,
		outputTokens: 300,
		totalTokens: 3_810,
		costUsdMicros: 6_040,
		pricedRequests: 3,
		estimatedCostUsdMicros: 2_000 * 4 + 200 * 20,
		estimatedRequests: 3,
		unratedRequests: 4,
		failedRequests: 4,
	});
	assert.deepEqual(
		report.daily.map((day) => [day.date, day.requests, day.failedRequests]),
		[
			["2026-10-27", 2, 0],
			["2026-10-28", 7, 4],
		],
	);
	const [, busy] = report.daily;
	assert.deepEqual(
		busy.models.map((row) => [row.key, row.requests]),
		[
			["claude-opus-5-5", 3],
			["mystery", 4],
		],
	);
	assert.deepEqual(
		busy.features.map((row) => row.key),
		["auto_triage", "chat"],
	);
	assert.deepEqual(
		report.breakdowns.provider.map((row) => [row.key, row.requests]),
		[
			["anthropic", 6],
			["custom", 4],
		],
	);
	assert.deepEqual(
		report.breakdowns.mailbox.map((row) => [row.key, row.label, row.failedRequests]),
		[
			["none", "No mailbox", 0],
			["mine", "me@example.com", 0],
			["other", "Other mailboxes", 4],
		],
	);
	assert.deepEqual(report.statuses, [
		{ status: "ok", requests: 3 },
		{ status: "failed", requests: 4 },
		{ status: "unrecorded", requests: 3 },
	]);
	assert.deepEqual(report.errorCodes, [{ code: "timeout", requests: 4 }]);
	// The model without any rate comes first: that is the one to act on.
	assert.deepEqual(report.missingRates, [
		{ model: "mystery", provider: "custom", requests: 4, rate: null, rateSource: null, configured: true },
		{
			model: "claude-opus-5-5",
			provider: "anthropic",
			requests: 3,
			rate: { input: 4, output: 20 },
			rateSource: "price_list",
			configured: true,
		},
	]);
	assert.deepEqual(report.filterOptions, {
		models: ["claude-opus-5-5", "mystery"],
		providers: ["anthropic", "custom"],
		features: ["auto_triage", "chat"],
		statuses: ["ok", "failed", "unrecorded"],
	});
});

function sums(requests, input, output, cost, priced, unpricedInput = 0, unpricedOutput = 0) {
	return {
		requests,
		inputTokens: input,
		outputTokens: output,
		costUsdMicros: cost,
		pricedRequests: priced,
		unpricedInputTokens: unpricedInput,
		unpricedOutputTokens: unpricedOutput,
	};
}

test("chart helpers stack each metric's parts, space the axis labels and keep the tooltip inside the chart", () => {
	const day = {
		inputTokens: 10,
		outputTokens: 5,
		costUsdMicros: 7,
		estimatedCostUsdMicros: 3,
		requests: 9,
		failedRequests: 2,
	};
	assert.deepEqual(chartParts(day, "tokens"), [10, 5]);
	assert.deepEqual(chartParts(day, "cost"), [7, 3]);
	assert.deepEqual(chartParts(day, "requests"), [7, 2]);
	assert.deepEqual([7, 30, 90].map(axisLabelEvery), [1, 5, 13]);
	// Beside the bar on the right, on the left near the right edge, and clamped on a narrow phone chart.
	assert.equal(tooltipLeft(100, 1000, 288), 112);
	assert.equal(tooltipLeft(900, 1000, 288), 600);
	assert.equal(tooltipLeft(150, 300, 288), 0);
	const rows = ["a", "b", "c", "d", "e", "f"].map((key, index) => ({
		key,
		...sums(index + 1, 10 * (6 - index), 0, 0, 0),
		estimatedCostUsdMicros: 0,
		estimatedRequests: 0,
		unratedRequests: 0,
		failedRequests: 0,
	}));
	assert.deepEqual(
		topRows(rows, "requests").shown.map((row) => row.key),
		["f", "e", "d", "c"],
	);
	assert.equal(topRows(rows, "tokens").more, 2);
});

async function database(t, { details = true } = {}) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, join(root, "drizzle/migrations"));
	if (!details)
		for (const column of ["status", "error_code", "duration_ms", "finish_reason", "input_rate", "output_rate"])
			db.db.exec(`ALTER TABLE ai_usage DROP COLUMN ${column}`);
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES
			('owner', 'owner@example.com', 'hash', 'Owner', 'admin', 1),
			('other', 'other@example.com', 'hash', 'Other', 'user', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('d', 'owner', 'example.com', 'z', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES
			('mine', 'owner', 'd', 'owner', 1),
			('theirs', 'other', 'd', 'other', 1);
		INSERT INTO mailbox_agent_settings (mailbox_id, daily_spend_cap_micros, updated_at) VALUES ('mine', 500000, 1), ('theirs', 100000, 1);
	`);
	return db;
}

function insert(db, row) {
	const columns = Object.keys(row);
	db.db
		.prepare(`INSERT INTO ai_usage (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
		.run(...Object.values(row));
}

const OWNER = { id: "owner", email: "owner@example.com", role: "admin" };
const now = () => Math.floor(Date.now() / 1000);

test("loadUsageReport answers the range, the filters, today's spend and the activity page from SQLite", async (t) => {
	const db = await database(t);
	const env = { DB: db };
	const base = { provider: "anthropic", model: "claude-opus-5-5", reserved: 0 };
	insert(db, {
		...base,
		id: "u-ok",
		created_at: now() - 60,
		source: "chat",
		input_tokens: 1_000,
		output_tokens: 100,
		cost_usd_micros: 6_000,
		mailbox_id: "mine",
		status: "ok",
		duration_ms: 1_234,
		finish_reason: "stop",
		input_rate: 4,
		output_rate: 20,
	});
	insert(db, {
		...base,
		id: "u-old",
		created_at: now() - 3 * 86_400,
		source: "auto_triage",
		input_tokens: 2_000,
		output_tokens: 200,
		mailbox_id: "theirs",
	});
	insert(db, {
		id: "u-failed",
		created_at: now() - 120,
		provider: "custom",
		model: "mystery",
		source: "compose",
		input_tokens: 0,
		output_tokens: 0,
		reserved: 0,
		status: "failed",
		error_code: "timeout",
	});
	// Older than 90 days: never shown.
	insert(db, { ...base, id: "u-ancient", created_at: now() - 120 * 86_400, source: "chat", input_tokens: 9 });

	const report = await loadUsageReport(env, OWNER, { range: 7, page: 1, filters: {} }, "UTC");
	assert.equal(report.detailsRecorded, true);
	assert.equal(report.daily.length, 7);
	assert.equal(report.totals.requests, 3);
	assert.equal(report.totals.costUsdMicros, 6_000);
	assert.equal(report.totals.estimatedCostUsdMicros, 2_000 * 4 + 200 * 20);
	assert.equal(report.totals.unratedRequests, 1);
	assert.equal(report.totals.failedRequests, 1);
	assert.deepEqual(report.errorCodes, [{ code: "timeout", requests: 1 }]);
	assert.deepEqual(report.breakdowns.mailbox.map((row) => row.label).sort(), [
		"No mailbox",
		"Other mailboxes",
		"owner@example.com",
	]);
	assert.deepEqual(
		report.rows.map((row) => row.id),
		["u-ok", "u-failed", "u-old"],
	);
	const [ok, failed, old] = report.rows;
	assert.deepEqual(
		[ok.status, ok.durationMs, ok.finishReason, ok.rate, ok.mailboxLabel],
		["ok", 1_234, "stop", { input: 4, output: 20, kind: "recorded" }, "owner@example.com"],
	);
	assert.deepEqual(
		[failed.status, failed.errorCode, failed.rate, failed.estimatedCostUsdMicros],
		["failed", "timeout", null, null],
	);
	// A row from before the price list: estimated at today's rate, and its mailbox is not named to this admin.
	assert.deepEqual(
		[old.status, old.estimatedCostUsdMicros, old.rate, old.mailboxId, old.mailboxLabel],
		["unrecorded", 12_000, { input: 4, output: 20, kind: "current" }, "theirs", null],
	);
	// Today's spend: the install cap, and only the mailbox caps this admin can see.
	assert.equal(report.spendToday.installSpentMicros, 6_000);
	assert.equal(report.spendToday.chatTokensUsed, 1_000);
	assert.deepEqual(report.spendToday.mailboxes, [
		{ id: "mine", label: "owner@example.com", capMicros: 500_000, spentMicros: 6_000 },
	]);

	const filtered = await loadUsageReport(env, OWNER, { range: 7, page: 1, filters: { status: "failed" } }, "UTC");
	assert.deepEqual(
		[filtered.totalRows, filtered.rows.map((row) => row.id), filtered.totals.requests],
		[1, ["u-failed"], 3],
	);
	const byFeature = await loadUsageReport(
		env,
		OWNER,
		{ range: 7, page: 1, filters: { model: "claude-opus-5-5", feature: "auto_triage", provider: "anthropic" } },
		"UTC",
	);
	assert.deepEqual(
		byFeature.rows.map((row) => row.id),
		["u-old"],
	);
	const all90 = await loadUsageReport(env, OWNER, { range: 90, page: 1, filters: {} }, "UTC");
	assert.equal(all90.daily.length, 90);
	assert.equal(all90.totals.requests, 3);
	const page2 = await loadUsageReport(env, OWNER, { range: 30, page: 2, filters: {} }, "UTC");
	assert.deepEqual([page2.rows.length, page2.totalPages], [0, 1]);
});

test("before migration 0077 the report still loads, with every settled row not recorded", async (t) => {
	const db = await database(t, { details: false });
	insert(db, {
		id: "u",
		created_at: now() - 60,
		provider: "anthropic",
		model: "claude-opus-5-5",
		source: "chat",
		input_tokens: 10,
		output_tokens: 1,
		reserved: 0,
	});
	insert(db, {
		id: "r",
		created_at: now() - 30,
		provider: "anthropic",
		model: "claude-opus-5-5",
		source: "chat",
		input_tokens: 10,
		output_tokens: 1,
		reserved: 1,
	});
	const report = await loadUsageReport({ DB: db }, OWNER, { range: 30, page: 1, filters: {} }, "UTC");
	assert.equal(report.detailsRecorded, false);
	assert.deepEqual(report.statuses, [
		{ status: "running", requests: 1 },
		{ status: "unrecorded", requests: 1 },
	]);
	assert.deepEqual(
		report.rows.map((row) => [row.id, row.status, row.durationMs]),
		[
			["r", "running", null],
			["u", "unrecorded", null],
		],
	);
	const running = await loadUsageReport(
		{ DB: db },
		OWNER,
		{ range: 30, page: 1, filters: { status: "running" } },
		"UTC",
	);
	assert.deepEqual(
		running.rows.map((row) => row.id),
		["r"],
	);
});
