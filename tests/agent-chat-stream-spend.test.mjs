import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-agent-chat-stream-spend-");
after(() => rmSync(outDir, { recursive: true, force: true }));

// import.meta.resolve (rather than a joined path) lets knip see which module this test uses.
await build({
	entryPoints: {
		chat: fileURLToPath(import.meta.resolve("../src/lib/agent/chat.ts")),
		state: join(root, "src/lib/modules/state.ts"),
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
const { createAgentChatStream } = await load("chat");
const { clearModuleStateCache } = await load("state");
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");

const realFetch = globalThis.fetch;
let respond;
after(() => {
	globalThis.fetch = realFetch;
});
beforeEach(() => {
	globalThis.fetch = async (url, init) => respond(init);
});

const encoder = new TextEncoder();
const chunk = (delta, finish = null) =>
	`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "priced", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

async function setup(t) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, join(root, "drizzle/migrations"));
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Owner', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'a', 'personal', 1);
		INSERT OR IGNORE INTO app_settings (id, updated_at) VALUES ('default', 1);
	`);
	db.db
		.prepare(
			"UPDATE app_settings SET agent_enabled = 1, agent_provider = 'compatible', agent_preset = 'custom', agent_base_url = 'https://model.test/v1', agent_api_key = 'test-key', agent_model = 'priced', agent_model_rates = ?",
		)
		.run(JSON.stringify({ priced: { input: 1, output: 2 } }));
	const env = { DB: db, AGENT_QUEUE: { send: async () => undefined } };
	globalThis.__kiteNodeEnv = env;
	t.after(() => {
		delete globalThis.__kiteNodeEnv;
		clearModuleStateCache();
	});
	const user = {
		id: "owner",
		name: "Owner",
		email: "owner@example.com",
		role: "user",
		agentMaxSteps: 5,
		timeZone: "UTC",
	};
	return { db, context: { env, user, mailboxId: "mailbox-a", origin: "chat" } };
}

async function readEvents(stream, onEvent = () => undefined) {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	const events = [];
	let buffer = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop();
		for (const line of lines.filter(Boolean)) {
			const event = JSON.parse(line);
			events.push(event);
			onEvent(event);
		}
	}
	return events;
}

const usageRows = (db) =>
	db.db
		.prepare("SELECT source, mailbox_id, reserved, input_tokens, output_tokens, cost_usd_micros FROM ai_usage")
		.all();

test("a chat step aborted mid-stream keeps its estimate and releases the reservation", async (t) => {
	const { db, context } = await setup(t);
	respond = (init) =>
		new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode(chunk({ role: "assistant", content: "" })));
					controller.enqueue(encoder.encode(chunk({ content: "Partial answer" })));
					init.signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")));
				},
			}),
			{ headers: { "Content-Type": "text/event-stream" } },
		);
	const abort = new AbortController();
	const { stream } = await createAgentChatStream(context, "Hello", undefined, abort.signal, "UTC");
	await readEvents(stream, (event) => {
		if (event.type === "text") abort.abort();
	});
	const rows = usageRows(db);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].source, "chat");
	assert.equal(rows[0].mailbox_id, "mailbox-a");
	assert.equal(rows[0].reserved, 0, "the reservation is closed");
	// The estimate stays: 1,200 output tokens at 2 micros plus the prompt's input tokens.
	assert.equal(rows[0].output_tokens, 1_200);
	assert.ok(rows[0].cost_usd_micros > 2_400);
});

test("a chat step the provider refuses keeps its estimate, closes the reservation and reports the error", async (t) => {
	const { db, context } = await setup(t);
	respond = async () => Response.json({ error: { message: "model overloaded" } }, { status: 400 });
	const { stream } = await createAgentChatStream(context, "Hello", undefined, undefined, "UTC");
	const events = await readEvents(stream);
	assert.ok(
		events.some((event) => event.type === "error" && /model overloaded/.test(event.message)),
		JSON.stringify(events),
	);
	const rows = usageRows(db);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].reserved, 0);
	assert.equal(rows[0].output_tokens, 1_200);
});

test("a finished chat step is settled with the usage the provider reported", async (t) => {
	const { db, context } = await setup(t);
	respond = async () =>
		new Response(
			[
				chunk({ role: "assistant", content: "" }),
				chunk({ content: "All done." }),
				chunk({}, "stop"),
				`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "priced", choices: [], usage: { prompt_tokens: 900, completion_tokens: 4, total_tokens: 904 } })}\n\n`,
				"data: [DONE]\n\n",
			].join(""),
			{ headers: { "Content-Type": "text/event-stream" } },
		);
	const { stream } = await createAgentChatStream(context, "Hello", undefined, undefined, "UTC");
	const events = await readEvents(stream);
	assert.deepEqual(events.at(-1), { type: "done" });
	assert.deepEqual(usageRows(db), [
		{ source: "chat", mailbox_id: "mailbox-a", reserved: 0, input_tokens: 900, output_tokens: 4, cost_usd_micros: 908 },
	]);
});
