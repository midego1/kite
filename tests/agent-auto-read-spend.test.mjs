import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import {
	UNKNOWN_RATES_INPUT_TOKEN_CAP,
	actualSpend,
	estimateSpend,
	spendMode,
	utcDayStartSeconds,
} from "../src/lib/agent/auto-read/spend-utils.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-agent-auto-read-spend-");
after(() => rmSync(outDir, { recursive: true, force: true }));

// import.meta.resolve (rather than a joined path) lets knip see which module this test uses.
await build({
	entryPoints: {
		spend: fileURLToPath(import.meta.resolve("../src/lib/agent/auto-read/spend.ts")),
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
const { reserveAiSpend, reconcileAiSpend, refusedSpendCap, keepReservedEstimate, withReservedSpend } =
	await load("spend");
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");

const NOW = new Date("2026-10-10T12:00:00Z");
const DAY_START = Date.UTC(2026, 9, 10) / 1000;
const PRICED = { provider: "compatible", modelId: "priced", rates: { input: 1, output: 2 } };
const UNPRICED = { provider: "cloudflare", modelId: "unpriced", rates: undefined };
// 400 chars → 100 input tokens; 100 × 1 + 50 × 2 = 200 micros.
const PRICED_ESTIMATE = 200;

async function database(t, filename = ":memory:", { migrate = true } = {}) {
	const db = new SqliteDatabase(filename);
	t.after(() => db.db.close());
	if (migrate) await applyMigrations(db, join(root, "drizzle/migrations"));
	db.db.exec(`
		INSERT OR IGNORE INTO users (id, email, password_hash, name, created_at) VALUES ('user-1', 'owner@example.com', 'hash', 'Owner', 1);
		INSERT OR IGNORE INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'user-1', 'example.com', 'zone-1', 'active', 1);
		INSERT OR IGNORE INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES
			('mailbox-a', 'user-1', 'domain-1', 'a', 1),
			('mailbox-b', 'user-1', 'domain-1', 'b', 1);
	`);
	return db;
}

function reserve(db, overrides = {}) {
	return reserveAiSpend({
		env: { DB: db },
		details: PRICED,
		source: "auto_triage",
		mailboxId: "mailbox-a",
		jobId: "job-a",
		promptChars: 400,
		maxOutputTokens: 50,
		installCapMicros: 10_000,
		mailboxCapMicros: null,
		tokenCap: UNKNOWN_RATES_INPUT_TOKEN_CAP,
		now: NOW,
		...overrides,
	});
}

function insertUsage(db, { mailboxId = null, cost = null, input = null, createdAt = DAY_START + 60, source = "chat" }) {
	db.db
		.prepare(
			"INSERT INTO ai_usage (id, created_at, provider, model, source, input_tokens, output_tokens, cost_usd_micros, mailbox_id) VALUES (?, ?, 'p', 'm', ?, ?, 0, ?, ?)",
		)
		.run(`usage-${Math.random()}`, createdAt, source, input, cost, mailboxId);
}

const rows = (db) => db.db.prepare("SELECT * FROM ai_usage ORDER BY created_at, id").all();

test("concurrent reservations for two mailboxes insert exactly one row when the install cap fits one estimate", async (t) => {
	const db = await database(t);
	const results = await Promise.all([
		reserve(db, { installCapMicros: PRICED_ESTIMATE }),
		reserve(db, { mailboxId: "mailbox-b", jobId: "job-b", installCapMicros: PRICED_ESTIMATE }),
	]);
	assert.equal(results.filter(Boolean).length, 1);
	assert.equal(results.filter((result) => result === null).length, 1);
	const stored = rows(db);
	assert.equal(stored.length, 1);
	assert.equal(stored[0].reserved, 1);
	assert.equal(stored[0].cost_usd_micros, PRICED_ESTIMATE);
});

test("reservations through two connections to one file still respect the cap", async (t) => {
	const filename = join(outDir, `race-${Date.now()}.sqlite`);
	const first = await database(t, filename);
	const second = await database(t, filename, { migrate: false });
	const results = await Promise.all(
		[first, second, first, second].map((db, index) =>
			reserve(db, {
				mailboxId: index % 2 ? "mailbox-b" : "mailbox-a",
				jobId: `job-${index}`,
				installCapMicros: PRICED_ESTIMATE,
			}),
		),
	);
	assert.equal(results.filter(Boolean).length, 1);
	assert.equal(rows(first).length, 1);
});

test("a reservation stores the estimate with its mailbox, job and source", async (t) => {
	const db = await database(t);
	const reservation = await reserve(db, { source: "auto_draft" });
	assert.equal(typeof reservation.startedAt, "number");
	assert.deepEqual(
		{ ...reservation, id: undefined, startedAt: undefined },
		{
			id: undefined,
			startedAt: undefined,
			mode: "cost",
			inputTokens: 100,
			outputTokens: 50,
			costUsdMicros: PRICED_ESTIMATE,
		},
	);
	const [row] = rows(db);
	assert.equal(row.id, reservation.id);
	assert.equal(row.created_at, Math.floor(NOW.getTime() / 1000));
	assert.equal(row.mailbox_id, "mailbox-a");
	assert.equal(row.job_id, "job-a");
	assert.equal(row.source, "auto_draft");
	assert.equal(row.provider, "compatible");
	assert.equal(row.model, "priced");
	assert.equal(row.input_tokens, 100);
	assert.equal(row.output_tokens, 50);
});

test("the install cap counts every caller's usage since 00:00 UTC", async (t) => {
	const db = await database(t);
	insertUsage(db, { cost: 9_000, createdAt: DAY_START - 1 });
	insertUsage(db, { cost: 9_800, source: "chat" });
	assert.ok(await reserve(db), "a reservation that lands exactly on the cap is allowed");
	assert.equal(await reserve(db), null);
});

test("the mailbox cap blocks only its own mailbox", async (t) => {
	const db = await database(t);
	insertUsage(db, { mailboxId: "mailbox-a", cost: 900, source: "auto_draft" });
	insertUsage(db, { mailboxId: "mailbox-a", cost: 900, createdAt: DAY_START - 10 });
	assert.ok(await reserve(db, { mailboxCapMicros: 1_100 }));
	assert.equal(await reserve(db, { mailboxCapMicros: 1_100 }), null);
	assert.ok(await reserve(db, { mailboxId: "mailbox-b", mailboxCapMicros: 1_100 }));
	assert.ok(await reserve(db, { mailboxCapMicros: null }));
});

test("the install cap blocks even when the mailbox cap has room", async (t) => {
	const db = await database(t);
	insertUsage(db, { mailboxId: "mailbox-b", cost: 9_900 });
	assert.equal(await reserve(db, { mailboxCapMicros: 1_000_000 }), null);
});

test("unknown rates apply the 2,000,000 input-token cap, including under a race", async (t) => {
	const db = await database(t);
	insertUsage(db, { input: UNKNOWN_RATES_INPUT_TOKEN_CAP - 150, source: "auto_draft" });
	insertUsage(db, { input: 5_000_000, createdAt: DAY_START - 1 });
	const results = await Promise.all([
		reserve(db, { details: UNPRICED, installCapMicros: 0, mailboxCapMicros: 0 }),
		reserve(db, { details: UNPRICED, mailboxId: "mailbox-b", jobId: "job-b", installCapMicros: 0 }),
	]);
	const granted = results.filter(Boolean);
	assert.equal(granted.length, 1);
	assert.deepEqual(
		{ ...granted[0], id: undefined, startedAt: undefined },
		{
			id: undefined,
			startedAt: undefined,
			mode: "tokens",
			inputTokens: 100,
			outputTokens: 50,
			costUsdMicros: null,
		},
	);
	assert.equal(rows(db).filter((row) => row.reserved === 1).length, 1);
});

test("reconcile replaces the estimate with actual usage and clears reserved", async (t) => {
	const db = await database(t);
	const reservation = await reserve(db);
	await reconcileAiSpend({
		env: { DB: db },
		reservation,
		rates: PRICED.rates,
		usage: { inputTokens: 80, outputTokens: 30, outputTokenDetails: { textTokens: 10, reasoningTokens: 20 } },
	});
	const [row] = rows(db);
	assert.equal(row.reserved, 0);
	assert.equal(row.input_tokens, 80);
	assert.equal(row.output_tokens, 30);
	assert.equal(row.cost_usd_micros, 80 + 30 * 2);
});

test("reconciling a failed call without usage bills nothing", async (t) => {
	const db = await database(t);
	const priced = await reserve(db);
	const unpriced = await reserve(db, { details: UNPRICED, jobId: "job-u" });
	await reconcileAiSpend({ env: { DB: db }, reservation: priced, rates: PRICED.rates });
	await reconcileAiSpend({ env: { DB: db }, reservation: unpriced, rates: undefined });
	const byId = Object.fromEntries(rows(db).map((row) => [row.id, row]));
	assert.deepEqual(
		[byId[priced.id].reserved, byId[priced.id].input_tokens, byId[priced.id].cost_usd_micros],
		[0, 0, 0],
	);
	assert.deepEqual(
		[byId[unpriced.id].reserved, byId[unpriced.id].input_tokens, byId[unpriced.id].cost_usd_micros],
		[0, 0, null],
	);
});

test("estimateSpend rounds prompt characters up to tokens and prices both sides", () => {
	assert.deepEqual(estimateSpend(401, 400, { input: 0.05, output: 0.3 }), {
		mode: "cost",
		inputTokens: 101,
		outputTokens: 400,
		costUsdMicros: Math.ceil(101 * 0.05 + 400 * 0.3),
	});
	assert.equal(estimateSpend(0, 0, undefined).inputTokens, 0);
	assert.equal(estimateSpend(-5, Number.NaN, { input: null, output: 1 }).mode, "tokens");
	assert.equal(estimateSpend(10, 10, { input: 1, output: null }).costUsdMicros, null);
});

test("spendMode needs both rates", () => {
	assert.equal(spendMode({ input: 1, output: 1 }), "cost");
	assert.equal(spendMode({ input: 0, output: 0 }), "cost");
	assert.equal(spendMode({ input: 1, output: null }), "tokens");
	assert.equal(spendMode(undefined), "tokens");
});

test("utcDayStartSeconds returns midnight UTC in seconds", () => {
	assert.equal(utcDayStartSeconds(NOW), DAY_START);
	assert.equal(utcDayStartSeconds(new Date("2026-10-10T00:00:00Z")), DAY_START);
	assert.equal(utcDayStartSeconds(new Date("2026-10-09T23:59:59.999Z")), DAY_START - 86_400);
});

test("actualSpend counts reasoning tokens as output", () => {
	const rates = { input: 1, output: 10 };
	assert.deepEqual(
		actualSpend(
			"cost",
			{ inputTokens: 5, outputTokens: 3, outputTokenDetails: { textTokens: 3, reasoningTokens: 7 } },
			rates,
		),
		{ inputTokens: 5, outputTokens: 10, costUsdMicros: 105 },
	);
	assert.deepEqual(actualSpend("cost", { inputTokens: 5, outputTokens: 12 }, rates), {
		inputTokens: 5,
		outputTokens: 12,
		costUsdMicros: 125,
	});
	assert.deepEqual(actualSpend("tokens", { inputTokens: 5, outputTokens: 2 }, rates), {
		inputTokens: 5,
		outputTokens: 2,
		costUsdMicros: null,
	});
	assert.deepEqual(actualSpend("cost", { inputTokens: 5, outputTokens: 2 }, undefined), {
		inputTokens: 5,
		outputTokens: 2,
		costUsdMicros: 0,
	});
});

test("without rates chat and automatic reading have separate token allowances, each with its own cap", async (t) => {
	const db = await database(t);
	insertUsage(db, { input: 1_000, source: "chat" });
	insertUsage(db, { input: 1_000, source: "auto_triage" });
	const chat = { details: UNPRICED, source: "chat", jobId: null, tokenCap: 1_050 };
	const triage = { details: UNPRICED, source: "auto_triage", tokenCap: 1_150 };
	// 100 input tokens per reservation: chat's 1,000 + 100 passes 1,050, triage's 1,000 + 100 fits 1,150.
	assert.equal(await reserve(db, chat), null);
	assert.ok(await reserve(db, triage));
	assert.equal(await reserve(db, triage), null, "the triage allowance now holds 1,100 + 100 > 1,150");
	insertUsage(db, { input: 5_000_000, source: "auto_draft" });
	assert.ok(await reserve(db, { ...chat, tokenCap: 1_100 }), "automatic reading's tokens never count against chat");
	assert.equal(await refusedSpendCap({ ...baseInput(), ...chat }), "chat_tokens");
	assert.equal(await refusedSpendCap({ ...baseInput(), ...triage }), "auto_read_tokens");

	function baseInput() {
		return {
			env: { DB: db },
			mailboxId: "mailbox-a",
			promptChars: 400,
			maxOutputTokens: 50,
			installCapMicros: 0,
			mailboxCapMicros: null,
			now: NOW,
		};
	}
});

test("a refused priced reservation names the mailbox cap only when that cap alone is passed", async (t) => {
	const db = await database(t);
	insertUsage(db, { mailboxId: "mailbox-a", cost: 900 });
	const input = {
		env: { DB: db },
		details: PRICED,
		source: "chat",
		mailboxId: "mailbox-a",
		jobId: null,
		promptChars: 400,
		maxOutputTokens: 50,
		installCapMicros: 10_000,
		tokenCap: UNKNOWN_RATES_INPUT_TOKEN_CAP,
		now: NOW,
	};
	assert.equal(await refusedSpendCap({ ...input, mailboxCapMicros: 1_000 }), "mailbox_dollars");
	assert.equal(await refusedSpendCap({ ...input, mailboxCapMicros: 5_000 }), "install_dollars");
	assert.equal(await refusedSpendCap({ ...input, mailboxCapMicros: null }), "install_dollars");
});

test("settling a request records its status, error code, duration, finish reason and the rates it was counted at", async (t) => {
	const db = await database(t);
	const env = { DB: db };
	const answered = await reserve(db);
	await reconcileAiSpend({
		env,
		reservation: answered,
		rates: PRICED.rates,
		usage: { inputTokens: 80, outputTokens: 30 },
		outcome: { status: "ok", finishReason: "stop" },
	});
	const stopped = await reserve(db, { jobId: "job-stopped" });
	await keepReservedEstimate(env, stopped);
	const failed = await reserve(db, { jobId: "job-failed" });
	await keepReservedEstimate(env, failed, { status: "failed", errorCode: "timeout" });
	const unpriced = await reserve(db, { details: UNPRICED, jobId: "job-unpriced" });
	await reconcileAiSpend({ env, reservation: unpriced, rates: undefined, usage: { inputTokens: 5, outputTokens: 5 } });
	const byId = Object.fromEntries(rows(db).map((row) => [row.id, row]));
	const pick = (row) => [row.status, row.error_code, row.finish_reason, row.input_rate, row.output_rate, row.reserved];
	assert.deepEqual(pick(byId[answered.id]), ["ok", null, "stop", 1, 2, 0]);
	assert.deepEqual(pick(byId[stopped.id]), ["stopped", null, null, null, null, 0]);
	assert.deepEqual(pick(byId[failed.id]), ["failed", "timeout", null, null, null, 0]);
	assert.deepEqual(pick(byId[unpriced.id]), ["ok", null, null, null, null, 0]);
	for (const row of Object.values(byId)) assert.ok(row.duration_ms >= 0 && row.duration_ms < 60_000, row.id);
	// The estimate stays as the spend of a request that ended without usage.
	assert.equal(byId[stopped.id].cost_usd_micros, PRICED_ESTIMATE);
});

test("withReservedSpend records an answer's finish reason and a thrown error's code", async (t) => {
	const db = await database(t);
	const input = {
		env: { DB: db },
		details: PRICED,
		source: "line_summary",
		mailboxId: "mailbox-a",
		jobId: "job-a",
		promptChars: 400,
		maxOutputTokens: 50,
		installCapMicros: 10_000,
		mailboxCapMicros: null,
		tokenCap: UNKNOWN_RATES_INPUT_TOKEN_CAP,
		now: NOW,
	};
	await withReservedSpend(input, async () => ({ usage: { inputTokens: 10, outputTokens: 5 }, finishReason: "length" }));
	const timeout = Object.assign(new Error("The operation timed out"), { name: "TimeoutError" });
	await assert.rejects(
		withReservedSpend({ ...input, jobId: "job-b" }, async () => {
			throw timeout;
		}),
	);
	const byJob = Object.fromEntries(rows(db).map((row) => [row.job_id, row]));
	assert.deepEqual([byJob["job-a"].status, byJob["job-a"].finish_reason], ["ok", "length"]);
	assert.equal(byJob["job-b"].status, "failed");
	assert.ok(byJob["job-b"].error_code, "a failure keeps its error code");
});

test("before migration 0078 settling still releases the reservation and stores the actual spend", async (t) => {
	const db = await database(t);
	for (const column of ["status", "error_code", "duration_ms", "finish_reason", "input_rate", "output_rate"])
		db.db.exec(`ALTER TABLE ai_usage DROP COLUMN ${column}`);
	const env = { DB: db };
	const answered = await reserve(db);
	await reconcileAiSpend({
		env,
		reservation: answered,
		rates: PRICED.rates,
		usage: { inputTokens: 80, outputTokens: 30 },
	});
	const stopped = await reserve(db, { jobId: "job-stopped" });
	await keepReservedEstimate(env, stopped);
	const byId = Object.fromEntries(rows(db).map((row) => [row.id, row]));
	assert.deepEqual([byId[answered.id].reserved, byId[answered.id].cost_usd_micros], [0, 80 + 30 * 2]);
	assert.equal(byId[stopped.id].reserved, 0);
	assert.equal("status" in byId[answered.id], false);
});
