import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

// The primary admin's external-provider opt-in covers every AI feature that sends mail to the provider: chat (each
// step), Write with Kite, summaries, automatic reading with its drafts, one-line summaries and the legacy auto-draft.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-agent-external-consent-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createSession } from "./src/lib/auth/session.ts";
			export { POST as postAgentChat } from "./src/app/api/agent/chat/route.ts";
			export { GET as getAgentSettings } from "./src/app/api/agent/settings/route.ts";
			export { processAgentDraftJob } from "./src/lib/agent/jobs/utils.ts";
			export { interactiveRefusal } from "./src/lib/agent/interactive-model.ts";
		`,
		resolveDir: root,
		sourcefile: "agent-external-consent-entry.ts",
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
const {
	SqliteDatabase,
	applyMigrations,
	createSession,
	postAgentChat,
	getAgentSettings,
	processAgentDraftJob,
	interactiveRefusal,
} = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);

/** A database, an OpenAI-compatible fake provider (external) and a session; `answer` scripts each request. */
async function harness(t, { answer } = {}) {
	const directory = mkdtempSync(join(tmpdir(), "kite-external-consent-"));
	const database = new SqliteDatabase(join(directory, "kite.sqlite"));
	t.after(() => {
		database.db.close();
		rmSync(directory, { recursive: true, force: true });
	});
	await applyMigrations(database, join(root, "drizzle", "migrations"));
	database.db.exec(`
		INSERT OR IGNORE INTO app_settings (id, updated_at) VALUES ('default', 1);
		UPDATE app_settings SET agent_enabled = 1, agent_external_auto_read_allowed = 0;
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('user-1', 'owner@example.com', 'hash', 'Owner', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'user-1', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-1', 'user-1', 'domain-1', 'owner', 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at)
		VALUES ('email-1', 'user-1', 'mailbox-1', 'inbound', 'customer@example.net', 'owner@example.com', 'Question', 'Can we meet?', 'received', 2);
	`);
	const requests = [];
	const server = createServer(async (request, response) => {
		let raw = "";
		for await (const part of request) raw += part;
		requests.push(JSON.parse(raw));
		response.writeHead(200, { "Content-Type": "text/event-stream" });
		const chunk = (delta, finishReason = null) =>
			response.write(
				`data: ${JSON.stringify({ id: "mock-1", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
			);
		await (answer ?? ((_, write) => (write({ role: "assistant", content: "Noted." }), write({}, "stop"))))(
			requests.length,
			chunk,
		);
		response.end("data: [DONE]\n\n");
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	const env = {
		DB: database,
		BUCKET: { get: async () => null, delete: async () => {} },
		AGENT_QUEUE: { send: async () => undefined },
		AI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
		AI_API_KEY: "test-key",
		AI_MODEL: "test-model",
	};
	globalThis.__kiteNodeEnv = env;
	t.after(() => {
		delete globalThis.__kiteNodeEnv;
	});
	const token = await createSession(env, "user-1");
	const allow = (allowed) =>
		database.db.prepare("UPDATE app_settings SET agent_external_auto_read_allowed = ?").run(allowed ? 1 : 0);
	const chat = (text = "What is in my inbox?") =>
		postAgentChat(
			new Request("http://kite.local/api/agent/chat", {
				method: "POST",
				headers: { Origin: "http://kite.local", Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				body: JSON.stringify({ mailboxId: "mailbox-1", text }),
			}),
		);
	const settings = () =>
		getAgentSettings(
			new Request("http://kite.local/api/agent/settings?mailboxId=mailbox-1", {
				headers: { Authorization: `Bearer ${token}` },
			}),
		);
	return { database, env, requests, allow, chat, settings };
}

const events = async (response) =>
	(await response.text())
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));

test("chat refuses an external provider without the opt-in before anything reaches it", async (t) => {
	const { database, requests, allow, chat } = await harness(t);
	const refused = await chat();
	assert.equal(refused.status, 403);
	assert.equal((await refused.json()).code, "external_provider_not_allowed");
	assert.equal(requests.length, 0);
	assert.equal(database.db.prepare("SELECT count(*) AS n FROM agent_conversations").get().n, 0);

	allow(true);
	const answered = await chat();
	assert.equal(answered.status, 200);
	assert.ok((await events(answered)).some((event) => event.type === "done"));
	assert.equal(requests.length, 1);
});

test("turning the opt-in off stops a chat turn before its next step", async (t) => {
	let allow;
	const { requests, chat, ...rest } = await harness(t, {
		answer: (count, write) => {
			if (count > 1) return void (write({ role: "assistant", content: "Too late." }), write({}, "stop"));
			// The primary admin turns the opt-in off while the first step runs; the tool call asks for a second step.
			allow(false);
			write({
				role: "assistant",
				tool_calls: [
					{
						index: 0,
						id: "call-1",
						type: "function",
						function: { name: "list_emails", arguments: '{"folder":"inbox","limit":5}' },
					},
				],
			});
			write({}, "tool_calls");
		},
	});
	allow = rest.allow;
	allow(true);
	const response = await chat();
	assert.equal(response.status, 200);
	const stream = await events(response);
	assert.equal(requests.length, 1);
	const error = stream.find((event) => event.type === "error");
	assert.equal(error?.code, "external_provider_not_allowed");
	assert.ok(!stream.some((event) => event.type === "text" && event.text === "Too late."));
});

test("the assistant settings tell the panel that chat is off for the external provider", async (t) => {
	const { allow, settings } = await harness(t);
	const blocked = await (await settings()).json();
	assert.equal(blocked.externalProviderBlocked, true);
	assert.equal(typeof blocked.providerLabel, "string");
	assert.ok(blocked.providerLabel.length > 0);
	allow(true);
	assert.equal((await (await settings()).json()).externalProviderBlocked, false);
});

test("the legacy auto-draft job is skipped without the opt-in and never calls the provider", async (t) => {
	const { database, env, requests } = await harness(t);
	database.db.exec(`
		INSERT INTO mailbox_agent_settings (mailbox_id, auto_draft_enabled, reviewer_user_id, updated_at) VALUES ('mailbox-1', 1, 'user-1', 1);
		INSERT INTO agent_jobs (id, mailbox_id, source_message_id, reviewer_user_id, next_attempt_at, created_at)
		VALUES ('ajob-1', 'mailbox-1', 'email-1', 'user-1', 1, ${Math.floor(Date.now() / 1000)});
	`);
	await processAgentDraftJob(env, "ajob-1");
	assert.deepEqual(database.db.prepare("SELECT status, reason, draft_id FROM agent_jobs WHERE id = 'ajob-1'").get(), {
		status: "skipped",
		reason: "external_provider_not_allowed",
		draft_id: null,
	});
	assert.equal(requests.length, 0);
});

test("Write with Kite and summaries share the refusal; Workers AI needs no opt-in", async (t) => {
	const { database, env, allow } = await harness(t);
	assert.equal(await interactiveRefusal(env), "external_provider_not_allowed");
	allow(true);
	assert.equal(await interactiveRefusal(env), null);
	allow(false);
	database.db.exec("UPDATE app_settings SET agent_provider = 'cloudflare'");
	const workersAi = { ...env, AI_BASE_URL: undefined, AI_API_KEY: undefined, AI: { run: async () => ({}) } };
	assert.equal(await interactiveRefusal(workersAi), null);
});

/** Every `.ts` file under `src`, relative to the repository. */
function sourceFiles(directory = join(root, "src")) {
	return readdirSync(directory).flatMap((name) => {
		const path = join(directory, name);
		if (statSync(path).isDirectory()) return sourceFiles(path);
		return /\.tsx?$/.test(name) ? [relative(root, path)] : [];
	});
}

test("every model selection goes through the opt-in", () => {
	const selectors = sourceFiles().filter((file) => /\bgetAgentModel\(/.test(readFileSync(join(root, file), "utf8")));
	// Picking a model directly is allowed only where the opt-in is checked right after it.
	assert.deepEqual(selectors.sort(), [
		"src/lib/agent/auto-read/auto-read-model.ts",
		"src/lib/agent/interactive-model.ts",
		"src/lib/agent/jobs/utils.ts",
		"src/lib/agent/model.ts",
	]);
	for (const file of selectors.filter((file) => !file.endsWith("/model.ts")))
		assert.match(readFileSync(join(root, file), "utf8"), /externalProviderRefused\(/, file);
	const chat = readFileSync(join(root, "src/lib/agent/chat.ts"), "utf8");
	assert.match(chat, /selectInteractiveModel\(/);
	assert.match(chat, /prepareStep: async[\s\S]{0,200}externalProviderRefused\(/);
	for (const file of sourceFiles().filter((file) =>
		/\b(streamText|generateText|generateObject|streamObject)\(/.test(readFileSync(join(root, file), "utf8")),
	))
		assert.ok(
			[
				"src/lib/agent/chat.ts",
				"src/lib/agent/compose.ts",
				"src/lib/agent/auto-read/triage-model.ts",
				"src/lib/agent/summaries/line-job.ts",
				"src/lib/agent/summaries/service.ts",
				"src/lib/agent/jobs/draft-generation.ts",
				"src/lib/agent/step-limit-utils.ts",
			].includes(file),
			`${file} calls a model: route its model through selectInteractiveModel or selectAutoReadModel and add it here`,
		);
});
