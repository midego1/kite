import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-agent-current-email-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createSession } from "./src/lib/auth/session.ts";
			export { POST as postAgentChat } from "./src/app/api/agent/chat/route.ts";
		`,
		resolveDir: root,
		sourcefile: "agent-current-email-entry.ts",
	},
	outfile: join(bundleDirectory, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	absWorkingDir: root,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: {
		"next/headers": "next/headers.js",
		"cloudflare:workers": "./server/runtime/cloudflare-workers.ts",
	},
	logLevel: "silent",
});
const { SqliteDatabase, applyMigrations, createSession, postAgentChat } = await import(
	pathToFileURL(join(bundleDirectory, "entry.mjs")).href
);
await build({
	entryPoints: [join(root, "src/lib/agent/current-email-utils.ts")],
	outfile: join(bundleDirectory, "utils.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
});
const utils = await import(pathToFileURL(join(bundleDirectory, "utils.mjs")).href);

const NOTE = /The user now has email (\S+) open/;

async function chatHarness(t) {
	const directory = mkdtempSync(join(tmpdir(), "kite-agent-current-"));
	const database = new SqliteDatabase(join(directory, "kite.sqlite"));
	t.after(() => {
		database.db.close();
		rmSync(directory, { recursive: true, force: true });
	});
	await applyMigrations(database, join(process.cwd(), "drizzle", "migrations"));
	// The provider is external (AI_BASE_URL), so chat needs the primary admin's opt-in.
	database.db.exec(
		"INSERT OR IGNORE INTO app_settings (id, updated_at) VALUES ('default', 1); UPDATE app_settings SET agent_external_auto_read_allowed = 1;",
	);
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('user-1', 'owner@example.com', 'hash', 'Owner', 1);
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('user-2', 'other@example.com', 'hash', 'Other', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'user-1', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-1', 'user-1', 'domain-1', 'owner', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-2', 'user-2', 'domain-1', 'other', 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at)
		VALUES ('email-own', 'user-1', 'mailbox-1', 'inbound', 'customer@example.net', 'owner@example.com', 'Question', 'Can we meet?', 'received', 2),
			('email-foreign', 'user-2', 'mailbox-2', 'inbound', 'customer@example.net', 'other@example.com', 'Elsewhere', 'Not yours', 'received', 2),
			('draft-other-user', 'user-2', 'mailbox-1', 'outbound', 'owner@example.com', 'customer@example.net', 'Their draft', 'Private', 'draft', 2);
	`);
	const requests = [];
	const server = createServer(async (request, response) => {
		let raw = "";
		for await (const chunk of request) raw += chunk;
		requests.push(JSON.parse(raw));
		response.writeHead(200, { "Content-Type": "text/event-stream" });
		const chunk = (delta, finishReason = null) =>
			response.write(
				`data: ${JSON.stringify({ id: "mock-1", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
			);
		chunk({ role: "assistant", content: "Noted." });
		chunk({}, "stop");
		response.end("data: [DONE]\n\n");
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	const env = {
		DB: database,
		BUCKET: { get: async () => null, delete: async () => {} },
		AI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
		AI_API_KEY: "test-key",
		AI_MODEL: "test-model",
	};
	globalThis.__kiteNodeEnv = env;
	t.after(() => {
		delete globalThis.__kiteNodeEnv;
	});
	const token = await createSession(env, "user-1");
	async function send(body) {
		requests.length = 0;
		const response = await postAgentChat(
			new Request("http://kite.local/api/agent/chat", {
				method: "POST",
				headers: { Origin: "http://kite.local", Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				body: JSON.stringify({ mailboxId: "mailbox-1", ...body }),
			}),
		);
		if (response.ok) await response.text();
		const userTurns = (requests[0]?.messages ?? []).filter((message) => message.role === "user");
		const last = userTurns.at(-1)?.content;
		return { status: response.status, last: typeof last === "string" ? last : JSON.stringify(last ?? "") };
	}
	return { database, send };
}

test("the open email reaches the model as an ID-only note on the latest turn and is never stored", async (t) => {
	const { database, send } = await chatHarness(t);
	const { status, last } = await send({ text: "Summarize this email", currentMessageId: "email-own" });
	assert.equal(status, 200);
	assert.equal(last.match(NOTE)?.[1], "email-own");
	assert.ok(last.startsWith("Summarize this email"));
	assert.doesNotMatch(last, /Question/);
	const stored = database.db.prepare("SELECT content FROM agent_chat_messages WHERE role = 'user'").all();
	assert.deepEqual(
		stored.map((row) => row.content),
		["Summarize this email"],
	);
});

test("an open email outside the mailbox or another user's draft is ignored", async (t) => {
	const { send } = await chatHarness(t);
	for (const currentMessageId of ["email-foreign", "draft-other-user", "missing-id"]) {
		const { status, last } = await send({ text: "What is this about?", currentMessageId });
		assert.equal(status, 200, currentMessageId);
		assert.equal(last, "What is this about?", currentMessageId);
	}
	const { last } = await send({ text: "What is this about?", currentMessageId: null });
	assert.equal(last, "What is this about?");
	assert.equal((await send({ text: "Hi", currentMessageId: "x".repeat(101) })).status, 400);
});

test("the current email note names only the email ID and follows the user's text", () => {
	assert.equal(utils.withCurrentEmailContext("Hello", null), "Hello");
	const noted = utils.withCurrentEmailContext("Hello", "email-9");
	assert.ok(noted.startsWith("Hello\n\n("));
	assert.ok(noted.endsWith(")"));
	assert.match(noted, /The user now has email email-9 open/);
	assert.match(noted, /"This email", "this thread" or "this message" means email email-9/);
	assert.match(noted, /read it with get_email using emailId email-9/);
	assert.match(noted, /Use get_thread when thread context is needed/);
});
