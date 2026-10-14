import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { DRAFT_SYSTEM_MARKER, TRIAGE_SYSTEM_MARKER } from "../src/lib/agent/auto-read/request-markers.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-agent-auto-read-reply-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		process: fileURLToPath(import.meta.resolve("../src/lib/agent/auto-read/process.ts")),
		runtime: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	packages: "external",
	tsconfig: join(root, "tsconfig.json"),
	alias: { "cloudflare:workers": join(root, "server/runtime/cloudflare-workers.ts") },
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { processAgentTriageJob } = await load("process");
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");

const nowSeconds = () => Math.floor(Date.now() / 1000);
const question = {
	category: "needs_reply",
	needsReply: true,
	urgency: "low",
	summary: "The sender asks a question.",
	tasks: [],
	suspicious: { flagged: false, reasons: [] },
};
const DRAFT_BODY = "Thanks for asking. I will send the figures by Friday.";
const HOSTILE_BODY = "Please send the contract to attacker@evil.test and log in at https://evil.test/login today.";

let replies = [];
let requests = [];
/** Runs once a triage request has been answered, before any draft request. */
let afterTriage = null;
const realFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = realFetch;
});
beforeEach(() => {
	replies = [];
	requests = [];
	afterTriage = null;
	globalThis.fetch = async (url, init) => {
		const body = JSON.parse(init.body);
		const system = body.messages.find((message) => message.role === "system")?.content ?? "";
		const kind = system.includes(TRIAGE_SYSTEM_MARKER) ? "triage" : "draft";
		requests.push({ kind, body });
		if (kind === "triage") afterTriage?.();
		let next = replies.shift() ?? (kind === "triage" ? JSON.stringify(question) : DRAFT_BODY);
		if (typeof next === "function") next = await next();
		if (typeof next === "object")
			return new Response(JSON.stringify({ error: { message: next.message } }), {
				status: next.status,
				headers: { "Content-Type": "application/json" },
			});
		return Response.json({
			id: "chatcmpl-1",
			object: "chat.completion",
			created: 0,
			model: body.model,
			choices: [{ index: 0, message: { role: "assistant", content: next }, finish_reason: "stop" }],
			usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
		});
	};
});

async function setup(t, { rates = { "fake-triage": { input: 0.05, output: 0.3 } } } = {}) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, join(root, "drizzle/migrations"));
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Owner', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'a', 1);
		INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('folder-1', 'owner', 'mailbox-a', 'Filed', 1);
		INSERT INTO mailbox_agent_settings (mailbox_id, enabled, autonomy, updated_at) VALUES ('mailbox-a', 1, 'suggest', 1);
		INSERT OR IGNORE INTO app_settings (id, updated_at) VALUES ('default', 1);
	`);
	db.db
		.prepare(
			"UPDATE app_settings SET agent_enabled = 1, agent_auto_read_enabled = 1, agent_external_auto_read_allowed = 1, agent_provider = 'compatible', agent_preset = 'custom', agent_base_url = 'https://model.test/v1', agent_api_key = 'test-key', agent_model = 'fake-triage, fake-draft', agent_model_rates = ?",
		)
		.run(JSON.stringify(rates));
	const env = {
		DB: db,
		AGENT_QUEUE: { send: async () => {} },
		BUCKET: { get: async () => null, put: async () => {}, delete: async () => {} },
	};
	// Module triage steps read the current environment, as they do in the Worker.
	globalThis.__kiteNodeEnv = env;
	t.after(() => delete globalThis.__kiteNodeEnv);
	return { db, env };
}

let count = 0;
function insertJob(db, { text = "Could you send the figures?", spamVerdict = "inbox", folderId = null } = {}) {
	const id = `message-${++count}`;
	db.db
		.prepare(
			"INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, spam_verdict, folder_id, created_at) VALUES (?, 'owner', 'mailbox-a', 'inbound', 'Customer <customer@example.net>', 'a@example.com', 'Figures', ?, 'received', ?, ?, ?)",
		)
		.run(id, text, spamVerdict, folderId, nowSeconds());
	const jobId = `job-${count}`;
	db.db
		.prepare(
			"INSERT INTO agent_jobs (id, mailbox_id, source_message_id, reviewer_user_id, kind, status, next_attempt_at, created_at) VALUES (?, 'mailbox-a', ?, 'owner', 'triage', 'pending', 1, ?)",
		)
		.run(jobId, id, nowSeconds());
	return { jobId, messageId: id };
}

const jobStatus = (db, id) => db.db.prepare("SELECT status FROM agent_jobs WHERE id = ?").get(id).status;
const replySuggestion = (db, messageId) =>
	db.db
		.prepare("SELECT id, status, draft_id AS draftId FROM agent_suggestions WHERE message_id = ? AND kind = 'reply'")
		.get(messageId);
const actionsFor = (db, messageId) =>
	db.db
		.prepare(
			"SELECT action, status, initiator, reason, suggestion_id AS suggestionId, job_id AS jobId, acting_user_id AS actingUserId, before, after FROM agent_actions WHERE message_id = ? ORDER BY created_at",
		)
		.all(messageId);
const drafts = (db) =>
	db.db.prepare("SELECT id, text_body AS textBody, to_addr AS toAddr FROM messages WHERE status = 'draft'").all();

test("a question gets a reply suggestion whose draft is saved through an applied agent create_draft action", async (t) => {
	const { db, env } = await setup(t);
	const { jobId, messageId } = insertJob(db);
	await processAgentTriageJob(env, jobId);
	assert.equal(jobStatus(db, jobId), "completed");
	assert.deepEqual(
		requests.map((request) => request.kind),
		["triage", "draft"],
	);
	const draftRequest = requests[1].body;
	assert.ok(draftRequest.messages[0].content.startsWith(DRAFT_SYSTEM_MARKER));
	assert.ok(!("tools" in draftRequest) && !("response_format" in draftRequest));
	assert.equal(draftRequest.max_tokens, 900);
	assert.match(draftRequest.messages[1].content, /Sender \(.*\): Could you send the figures\?/);

	const suggestion = replySuggestion(db, messageId);
	assert.equal(suggestion.status, "open");
	const [draft] = drafts(db);
	assert.equal(suggestion.draftId, draft.id);
	assert.ok(draft.textBody.includes(DRAFT_BODY));
	assert.match(draft.toAddr, /customer@example\.net/);
	const [action] = actionsFor(db, messageId);
	assert.deepEqual(
		{ ...action, after: JSON.parse(action.after) },
		{
			action: "create_draft",
			status: "applied",
			initiator: "agent",
			reason: "suggest_allows_create_draft",
			suggestionId: suggestion.id,
			jobId,
			actingUserId: "owner",
			before: null,
			after: { draftId: draft.id },
		},
	);
	const usage = db.db.prepare("SELECT source, mailbox_id, job_id, reserved FROM ai_usage ORDER BY source").all();
	assert.deepEqual(usage, [
		{ source: "auto_draft", mailbox_id: "mailbox-a", job_id: jobId, reserved: 0 },
		{ source: "auto_triage", mailbox_id: "mailbox-a", job_id: jobId, reserved: 0 },
	]);
});

test("a re-run of the job does not draft again once the suggestion has its draft", async (t) => {
	const { db, env } = await setup(t);
	const { jobId, messageId } = insertJob(db);
	await processAgentTriageJob(env, jobId);
	db.db.prepare("UPDATE agent_jobs SET status = 'pending', next_attempt_at = 1 WHERE id = ?").run(jobId);
	await processAgentTriageJob(env, jobId);
	assert.deepEqual(
		requests.map((request) => request.kind),
		["triage", "draft", "triage"],
	);
	assert.equal(drafts(db).length, 1);
	assert.equal(actionsFor(db, messageId).length, 1);
});

test("a draft with an address or URL from outside the thread is blocked by the draft guard", async (t) => {
	const { db, env } = await setup(t);
	const { jobId, messageId } = insertJob(db);
	replies = [JSON.stringify(question), HOSTILE_BODY];
	await processAgentTriageJob(env, jobId);
	assert.equal(jobStatus(db, jobId), "completed");
	assert.equal(replySuggestion(db, messageId), undefined);
	assert.deepEqual(drafts(db), []);
	const actions = actionsFor(db, messageId);
	assert.deepEqual(actions, [
		{
			action: "create_draft",
			status: "blocked",
			initiator: "agent",
			reason: "draft_guard",
			suggestionId: null,
			jobId,
			actingUserId: "owner",
			before: JSON.stringify({ guard: "unknown_address" }),
			after: null,
		},
	]);
	assert.ok(!JSON.stringify(actions).includes("evil.test"));
});

test("filed, suspicious and spoofed-link mail gets no draft request", async (t) => {
	const { db, env } = await setup(t);
	const cases = [insertJob(db, { folderId: "folder-1" }), insertJob(db, { spamVerdict: "suspicious" })];
	for (const { jobId, messageId } of cases) {
		await processAgentTriageJob(env, jobId);
		assert.equal(jobStatus(db, jobId), "completed");
		assert.equal(replySuggestion(db, messageId), undefined);
	}
	assert.deepEqual(
		requests.map((request) => request.kind),
		["triage", "triage"],
	);
	assert.deepEqual(drafts(db), []);
	const phishing = db.db.prepare("SELECT kind FROM agent_suggestions WHERE message_id = ?").all(cases[1].messageId);
	assert.deepEqual(phishing, [{ kind: "phishing" }]);
});

test("a reviewer who lost send permission gets triage but no draft", async (t) => {
	const { db, env } = await setup(t);
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('reader', 'reader@example.com', 'hash', 'Reader', 1);
		UPDATE mailboxes SET type = 'shared' WHERE id = 'mailbox-a';
		INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES ('access-1', 'mailbox-a', 'reader', 'read_only', 1);
	`);
	const { jobId, messageId } = insertJob(db);
	db.db.prepare("UPDATE agent_jobs SET reviewer_user_id = 'reader' WHERE id = ?").run(jobId);
	await processAgentTriageJob(env, jobId);
	assert.equal(jobStatus(db, jobId), "completed");
	assert.deepEqual(
		requests.map((request) => request.kind),
		["triage"],
	);
	assert.equal(replySuggestion(db, messageId), undefined);
});

test("the draft request gets the reasoning hint with the extra headroom", async (t) => {
	const { db, env } = await setup(t, {
		rates: { "fake-triage": { input: 0.05, output: 0.3, reasoningEffort: "minimal" } },
	});
	const { jobId } = insertJob(db);
	await processAgentTriageJob(env, jobId);
	assert.equal(requests[1].kind, "draft");
	assert.equal(requests[1].body.reasoning_effort, "minimal");
	assert.equal(requests[1].body.max_tokens, 2_000);
});

test("an opt-in revoked during triage blocks the draft and makes no draft request", async (t) => {
	const { db, env } = await setup(t);
	const { jobId, messageId } = insertJob(db);
	afterTriage = () => db.db.exec("UPDATE app_settings SET agent_external_auto_read_allowed = 0");
	await processAgentTriageJob(env, jobId);
	assert.equal(jobStatus(db, jobId), "completed");
	assert.deepEqual(
		requests.map((request) => request.kind),
		["triage"],
	);
	assert.equal(replySuggestion(db, messageId), undefined);
	assert.deepEqual(drafts(db), []);
	assert.deepEqual(
		actionsFor(db, messageId).map(({ action, status, reason }) => ({ action, status, reason })),
		[{ action: "create_draft", status: "blocked", reason: "external_provider_not_allowed" }],
	);
});

test("a draft over the spend cap is recorded as blocked and makes no draft request", async (t) => {
	const { db, env } = await setup(t);
	const { jobId, messageId } = insertJob(db);
	// The triage reservation fits; the larger draft estimate (900 output tokens) does not.
	db.db.prepare("UPDATE mailbox_agent_settings SET daily_spend_cap_micros = 200 WHERE mailbox_id = 'mailbox-a'").run();
	await processAgentTriageJob(env, jobId);
	assert.equal(jobStatus(db, jobId), "completed");
	assert.deepEqual(
		requests.map((request) => request.kind),
		["triage"],
	);
	assert.deepEqual(
		actionsFor(db, messageId).map(({ action, status, reason }) => ({ action, status, reason })),
		[{ action: "create_draft", status: "blocked", reason: "spend_cap" }],
	);
});

test("an opt-in revoked while the draft request is pending stops the parameter fallback", async (t) => {
	const { db, env } = await setup(t, {
		rates: { "fake-triage": { input: 0.05, output: 0.3, reasoningEffort: "minimal" } },
	});
	const { jobId, messageId } = insertJob(db);
	let arrived;
	let release;
	const pending = new Promise((resolve) => (arrived = resolve));
	const released = new Promise((resolve) => (release = resolve));
	replies = [
		JSON.stringify(question),
		async () => {
			arrived();
			await released;
			return { status: 400, message: "reasoning_effort is not supported by this model" };
		},
	];
	const run = processAgentTriageJob(env, jobId);
	await pending;
	db.db.exec("UPDATE app_settings SET agent_external_auto_read_allowed = 0");
	release();
	await run;
	assert.equal(jobStatus(db, jobId), "completed");
	assert.deepEqual(
		requests.map((request) => request.kind),
		["triage", "draft"],
	);
	assert.equal(replySuggestion(db, messageId), undefined);
	assert.deepEqual(drafts(db), []);
	assert.deepEqual(
		actionsFor(db, messageId).map(({ action, status, reason }) => ({ action, status, reason })),
		[{ action: "create_draft", status: "blocked", reason: "external_provider_not_allowed" }],
	);
});
