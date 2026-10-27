import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-agent-chat-spend-");
after(() => rmSync(outDir, { recursive: true, force: true }));

// import.meta.resolve (rather than a joined path) lets knip see which modules this test uses.
await build({
	entryPoints: {
		spend: fileURLToPath(import.meta.resolve("../src/lib/agent/chat-spend.ts")),
		utils: fileURLToPath(import.meta.resolve("../src/lib/agent/chat-spend-utils.ts")),
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
const { ChatSpendCapError, createChatSpend } = await load("spend");
const { CHAT_STEP_MAX_OUTPUT_TOKENS, spendCapMessage, stepPromptChars } = await load("utils");
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");

const PRICED = { provider: "compatible", modelId: "priced", rates: { input: 1, output: 2 } };
// 400 characters → 100 input tokens; 100 × 1 + 1200 × 2 = 2,500 micros reserved per step.
const STEP_ESTIMATE = 100 + CHAT_STEP_MAX_OUTPUT_TOKENS * 2;
// 100 input and 600 output tokens actually used: 100 + 1,200 = 1,300 micros.
const STEP_USAGE = { inputTokens: 100, outputTokens: 600 };
const STEP_ACTUAL = 1_300;

async function database(t) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, join(root, "drizzle/migrations"));
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('user-1', 'owner@example.com', 'hash', 'Owner', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'user-1', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-a', 'user-1', 'domain-1', 'a', 1);
	`);
	return db;
}

const rows = (db) =>
	db.db
		.prepare("SELECT source, mailbox_id, job_id, cost_usd_micros, reserved FROM ai_usage ORDER BY created_at, rowid")
		.all();

function chatSpend(db, overrides = {}) {
	return createChatSpend({
		env: { DB: db },
		details: PRICED,
		mailboxId: "mailbox-a",
		installCapMicros: 1_000_000,
		mailboxCapMicros: null,
		tokenCap: 2_000_000,
		...overrides,
	});
}

test("a step's prompt size counts the system prompt and every message, structured content as JSON", () => {
	const parts = [{ type: "tool-call", toolName: "list_emails", input: {} }];
	assert.equal(
		stepPromptChars("system", [{ content: "hello" }, { content: parts }, { content: null }]),
		6 + 5 + JSON.stringify(parts).length,
	);
});

test("a turn whose second step would pass the install cap stops after the first, which is reconciled", async (t) => {
	const db = await database(t);
	const spend = chatSpend(db, { installCapMicros: STEP_ESTIMATE + STEP_ACTUAL - 1 });
	await spend.beforeStep(400);
	assert.deepEqual(rows(db), [
		{ source: "chat", mailbox_id: "mailbox-a", job_id: null, cost_usd_micros: STEP_ESTIMATE, reserved: 1 },
	]);
	await spend.afterStep(STEP_USAGE);
	await assert.rejects(spend.beforeStep(400), (error) => {
		assert.ok(error instanceof ChatSpendCapError);
		assert.equal(error.cap, "install_dollars");
		assert.equal(
			error.message,
			"Daily AI spend cap reached: the install's $0.00 for today is used up. It resets at 00:00 UTC. The primary admin can change it in Admin → Agent.",
		);
		return true;
	});
	await spend.settle();
	assert.deepEqual(rows(db), [
		{ source: "chat", mailbox_id: "mailbox-a", job_id: null, cost_usd_micros: STEP_ACTUAL, reserved: 0 },
	]);
});

test("the mailbox cap stops a chat step too, and other mailboxes' spend does not count toward it", async (t) => {
	const db = await database(t);
	db.db.exec(
		`INSERT INTO ai_usage (id, created_at, provider, model, source, cost_usd_micros) VALUES ('other', ${Math.floor(Date.now() / 1000)}, 'p', 'm', 'auto_triage', 900000)`,
	);
	const spend = chatSpend(db, { mailboxCapMicros: STEP_ESTIMATE });
	await spend.beforeStep(400);
	await spend.afterStep(STEP_USAGE);
	await assert.rejects(
		spend.beforeStep(400),
		(error) => error.cap === "mailbox_dollars" && /this mailbox's \$0\.00/.test(error.message),
	);
});

test("without model rates chat stops at its own token allowance and says so", async (t) => {
	const db = await database(t);
	db.db.exec(
		`INSERT INTO ai_usage (id, created_at, provider, model, source, input_tokens) VALUES ('triage', ${Math.floor(Date.now() / 1000)}, 'p', 'm', 'auto_triage', 5000000)`,
	);
	const spend = chatSpend(db, {
		details: { provider: "cloudflare", modelId: "unpriced", rates: undefined },
		tokenCap: 150,
	});
	await spend.beforeStep(400);
	await spend.afterStep({ inputTokens: 100, outputTokens: 10 });
	await assert.rejects(spend.beforeStep(400), (error) => {
		assert.equal(error.cap, "chat_tokens");
		assert.match(error.message, /^Daily AI token allowance reached: chat has used its 150 input tokens for today\./);
		assert.match(error.message, /resets at 00:00 UTC.*Admin → Agent/);
		return true;
	});
});

test("every cap has a message that names it, when it resets and where it is changed", () => {
	const limits = { installCapMicros: 2_000_000, mailboxCapMicros: 500_000, tokenCap: 2_000_000 };
	const messages = Object.fromEntries(
		["install_dollars", "mailbox_dollars", "chat_tokens", "auto_read_tokens"].map((cap) => [
			cap,
			spendCapMessage(cap, limits),
		]),
	);
	assert.match(messages.install_dollars, /install's \$2\.00/);
	assert.match(messages.mailbox_dollars, /this mailbox's \$0\.50.*Automatic reading in the assistant settings/);
	assert.match(messages.chat_tokens, /chat has used its 2,000,000 input tokens/);
	assert.match(messages.auto_read_tokens, /automatic reading has used its 2,000,000 input tokens/);
	for (const message of Object.values(messages)) assert.match(message, /resets at 00:00 UTC/);
});

test("a step that ends without usage keeps its estimate and releases the reservation", async (t) => {
	const db = await database(t);
	const spend = chatSpend(db);
	await spend.beforeStep(400);
	await spend.settle();
	await spend.settle();
	await spend.afterStep(STEP_USAGE);
	assert.deepEqual(rows(db), [
		{ source: "chat", mailbox_id: "mailbox-a", job_id: null, cost_usd_micros: STEP_ESTIMATE, reserved: 0 },
	]);
});

test("every step of a turn is reserved and reconciled once", async (t) => {
	const db = await database(t);
	const spend = chatSpend(db);
	for (let step = 0; step < 3; step++) {
		await spend.beforeStep(400);
		await spend.afterStep(STEP_USAGE);
	}
	await spend.settle();
	const stored = rows(db);
	assert.equal(stored.length, 3);
	assert.ok(stored.every((row) => row.reserved === 0 && row.cost_usd_micros === STEP_ACTUAL));
});
