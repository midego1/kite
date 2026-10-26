import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-compose-stream-");
after(() => rmSync(outDir, { recursive: true, force: true }));

// import.meta.resolve (rather than a joined path) lets knip see which modules this test uses.
await build({
	entryPoints: {
		compose: fileURLToPath(import.meta.resolve("../src/lib/agent/compose.ts")),
		interactive: fileURLToPath(import.meta.resolve("../src/lib/agent/interactive-model.ts")),
		runtime: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	sourcemap: "inline",
	splitting: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	packages: "external",
	tsconfig: join(root, "tsconfig.json"),
	alias: { "cloudflare:workers": join(root, "server/runtime/cloudflare-workers.ts") },
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { ComposeRefusal, createComposeStream } = await load("compose");
const { InteractiveModelRefusedError, selectInteractiveModel } = await load("interactive");
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");

const realFetch = globalThis.fetch;
let requests;
let answer;
after(() => {
	globalThis.fetch = realFetch;
});
beforeEach(() => {
	requests = [];
	answer = "Tuesday at ten works for me.";
	globalThis.fetch = async (url, init) => {
		const body = JSON.parse(init.body);
		requests.push(body);
		if (answer instanceof Error) return Response.json({ error: { message: answer.message } }, { status: 400 });
		const chunk = (delta, finish = null, extra = {}) =>
			`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: body.model, choices: delta ? [{ index: 0, delta, finish_reason: finish }] : [], ...extra })}\n\n`;
		return new Response(
			[
				chunk({ role: "assistant", content: "" }),
				chunk({ content: answer }),
				chunk({}, "stop"),
				chunk(null, null, { usage: { prompt_tokens: 500, completion_tokens: 10, total_tokens: 510 } }),
				"data: [DONE]\n\n",
			].join(""),
			{ headers: { "Content-Type": "text/event-stream" } },
		);
	};
});

async function setup(t, { allowed = 1, provider = "compatible" } = {}) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, join(root, "drizzle/migrations"));
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Alex Owner', 1), ('other', 'other@example.com', 'hash', 'Other', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'alex', 'personal', 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, thread_id, provider_message_id, created_at) VALUES
			('source-1', 'owner', 'mailbox-a', 'inbound', 'Sam <sam@partner.test>', 'alex@example.com', 'Meeting', 'Can we meet Tuesday? Details: https://partner.test/agenda', 'received', 'thread-1', '<m1@partner.test>', 2),
			('foreign-draft', 'other', 'mailbox-a', 'outbound', 'alex@example.com', 'x@y.test', 'Secret', 'Other user secret draft', 'draft', 'thread-2', '<d2@example.com>', 3);
		INSERT OR IGNORE INTO app_settings (id, updated_at) VALUES ('default', 1);
	`);
	db.db
		.prepare(
			"UPDATE app_settings SET agent_enabled = 1, agent_external_auto_read_allowed = ?, agent_provider = ?, agent_preset = 'custom', agent_base_url = 'https://model.test/v1', agent_api_key = 'test-key', agent_model = 'priced', agent_model_rates = ?",
		)
		.run(allowed, provider, JSON.stringify({ priced: { input: 1, output: 2 } }));
	const env = { DB: db, AI: {} };
	globalThis.__kiteNodeEnv = env;
	t.after(() => delete globalThis.__kiteNodeEnv);
	const user = { id: "owner", name: "Alex Owner", email: "owner@example.com", role: "user", agentMaxSteps: 5 };
	return { db, env, user };
}

async function events(stream) {
	return (await new Response(stream).text())
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

const usage = (db) =>
	db.db.prepare("SELECT source, mailbox_id, reserved, input_tokens, output_tokens FROM ai_usage").all();

test("an external provider needs the primary admin's opt-in on every request; Workers AI does not", async (t) => {
	const { db, env } = await setup(t, { allowed: 0 });
	for (let attempt = 0; attempt < 2; attempt++)
		await assert.rejects(selectInteractiveModel(env, null), (error) => {
			assert.ok(error instanceof InteractiveModelRefusedError);
			assert.equal(error.reason, "external_provider_not_allowed");
			return true;
		});
	db.db.exec("UPDATE app_settings SET agent_external_auto_read_allowed = 1");
	assert.equal((await selectInteractiveModel(env, null)).providerKind, "compatible");
	db.db.exec("UPDATE app_settings SET agent_external_auto_read_allowed = 0, agent_provider = 'cloudflare'");
	assert.equal((await selectInteractiveModel(env, null)).providerKind, "cloudflare");
	db.db.exec("UPDATE app_settings SET agent_enabled = 0");
	await assert.rejects(selectInteractiveModel(env, null), (error) => error.reason === "assistant_disabled");
});

test("a reply is written from the email the server loads, streamed, checked and settled in ai_usage only", async (t) => {
	const { db, env, user } = await setup(t);
	const stream = await createComposeStream(env, user, {
		mailboxId: "mailbox-a",
		mode: "write",
		instruction: "Say Tuesday works",
		subject: "Re: Meeting",
		to: ["Sam <sam@partner.test>"],
		inReplyTo: "m1@partner.test",
		threadId: "thread-1",
	});
	assert.deepEqual(await events(stream), [
		{ type: "text", text: "Tuesday at ten works for me." },
		{ type: "done", text: "Tuesday at ten works for me.", warnings: [] },
	]);
	const [request] = requests;
	assert.equal(request.tools, undefined, "no tools");
	const content = request.messages.at(-1).content;
	assert.match(content, /<<<EMAIL id=source-1 nonce=\w+>>>[\s\S]*Can we meet Tuesday\?[\s\S]*<<<END \w+>>>/);
	assert.match(content, /Recipients' names: Sam\n/);
	assert.deepEqual(usage(db), [
		{ source: "compose", mailbox_id: "mailbox-a", reserved: 0, input_tokens: 500, output_tokens: 10 },
	]);
	assert.equal(db.db.prepare("SELECT count(*) AS n FROM agent_chat_messages").get().n, 0);
});

test("another user's draft is never read as the email being answered", async (t) => {
	const { env, user } = await setup(t);
	await events(
		await createComposeStream(env, user, {
			mailboxId: "mailbox-a",
			mode: "write",
			instruction: "Hi",
			inReplyTo: "<d2@example.com>",
			threadId: "thread-2",
		}),
	);
	assert.doesNotMatch(requests[0].messages.at(-1).content, /<<<EMAIL|secret/i);
});

test("links and addresses the user's text and the email do not contain are removed from the answer", async (t) => {
	const { env, user } = await setup(t);
	answer = "See https://partner.test/agenda and https://evil.test/x, or write to boss@evil.test.";
	const result = await events(
		await createComposeStream(env, user, {
			mailboxId: "mailbox-a",
			mode: "write",
			instruction: "Answer",
			inReplyTo: "m1@partner.test",
		}),
	);
	assert.deepEqual(result.at(-1), {
		type: "done",
		text: "See https://partner.test/agenda and, or write to.",
		warnings: ["removed_link", "removed_address"],
	});
});

test("a request over a cap is refused before the model is called, naming the cap", async (t) => {
	const { db, env, user } = await setup(t);
	db.db.exec(
		"INSERT INTO mailbox_agent_settings (mailbox_id, enabled, daily_spend_cap_micros, updated_at) VALUES ('mailbox-a', 1, 0, 1)",
	);
	await assert.rejects(
		createComposeStream(env, user, { mailboxId: "mailbox-a", mode: "rewrite", action: "shorter", text: "Hello there" }),
		(error) => {
			assert.ok(error instanceof ComposeRefusal);
			assert.equal(error.status, 429);
			assert.equal(error.code, "spend_cap");
			assert.match(error.message, /^Daily AI spend cap reached: this mailbox's \$0\.00 .* resets at 00:00 UTC/);
			return true;
		},
	);
	assert.equal(requests.length, 0);
	assert.deepEqual(usage(db), []);
});

test("a mailbox the user cannot send from answers 404, and a failed call keeps its estimate", async (t) => {
	const { db, env, user } = await setup(t);
	await assert.rejects(
		createComposeStream(
			env,
			{ ...user, id: "other", name: "Other" },
			{ mailboxId: "mailbox-a", mode: "write", instruction: "Hi" },
		),
		(error) => error instanceof ComposeRefusal && error.status === 404,
	);
	answer = new Error("model overloaded");
	const result = await events(
		await createComposeStream(env, user, { mailboxId: "mailbox-a", mode: "rewrite", action: "grammar", text: "Helo" }),
	);
	assert.match(result.at(-1).error, /model overloaded/);
	const [row] = usage(db);
	assert.equal(row.reserved, 0);
	assert.ok(row.output_tokens > 0, "the estimate stays");
});
