import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { copyMigrationsBefore, migrationsDir } from "./support/module-database.mjs";
import { root } from "./support/modules-bundle.mjs";

// "No AI for this mailbox": with the switch on, nothing from the mailbox reaches the AI provider by any route, while
// another mailbox keeps working. The fake provider records every request; the off mailbox's mail carries a token
// that must never appear in one.

const MODULES = [
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
	["createSession", "src/lib/auth/session.ts"],
	["POST as postAgentChat", "src/app/api/agent/chat/route.ts"],
	["GET as getAgentSettings", "src/app/api/agent/settings/route.ts"],
	["PUT as putMailboxAi", "src/app/api/agent/settings/ai/route.ts"],
	["GET as getCompose", "src/app/api/agent/compose/route.ts"],
	["createComposeStream", "src/lib/agent/compose.ts"],
	["createSummary, getSummaryState", "src/lib/agent/summaries/service.ts"],
	["processAgentDraftJob", "src/lib/agent/jobs/utils.ts"],
	["processAgentTriageJob", "src/lib/agent/auto-read/process.ts"],
	["processLineSummaryJob", "src/lib/agent/summaries/line-job.ts"],
	["scheduleAgentWork", "src/lib/agent/auto-read/schedule.ts"],
	["getAgentModel", "src/lib/agent/model.ts"],
	["aiOffMailboxIds", "src/lib/agent/mailbox-ai.ts"],
	["runEmailTool", "src/lib/agent/tools.ts"],
	["loadRowLines", "src/lib/agent/summaries/lines.ts"],
	["listSuggestions", "src/lib/agent/auto-read/suggestion-api.ts"],
	["createDb", "src/db/index.ts"],
	["aiHiddenSources, aiOffSince", "src/lib/agent/mailbox-ai.ts"],
	["listSubscriptionsTool", "src/lib/finance/tools.ts"],
	["runCalendarTool", "src/lib/calendar/tools.ts"],
	["moduleHost", "src/lib/modules/host.ts"],
];
const bundleDirectory = makeBundleDirectory("kite-mailbox-ai-off-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: MODULES.map(([names, file]) => `export { ${names} } from "./${file}";`).join("\n"),
		resolveDir: root,
		sourcefile: "mailbox-ai-off-entry.ts",
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
		"next/server": "next/server.js",
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
	putMailboxAi,
	getCompose,
	createComposeStream,
	createSummary,
	getSummaryState,
	processAgentDraftJob,
	processAgentTriageJob,
	processLineSummaryJob,
	scheduleAgentWork,
	getAgentModel,
	aiOffMailboxIds,
	runEmailTool,
	loadRowLines,
	listSuggestions,
	createDb,
	aiHiddenSources,
	aiOffSince,
	listSubscriptionsTool,
	runCalendarTool,
	moduleHost,
} = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);

const scratch = makeBundleDirectory("kite-mailbox-ai-off-dirs-");
after(() => rmSync(scratch, { recursive: true, force: true }));

/** Appears only in the mail of the mailbox with AI off. */
const MARKER = "NOAI-7731-MARKER";
const now = () => Math.floor(Date.now() / 1000);

const owner = {
	id: "user-1",
	email: "owner@example.com",
	role: "admin",
	isPrimaryAdmin: true,
	name: "Owner",
	timeZone: "UTC",
	disabled: false,
};

async function harness(t, { migrations = migrationsDir } = {}) {
	const directory = mkdtempSync(join(tmpdir(), "kite-mailbox-ai-off-"));
	const database = new SqliteDatabase(join(directory, "kite.sqlite"));
	t.after(() => {
		database.db.close();
		rmSync(directory, { recursive: true, force: true });
	});
	await applyMigrations(database, migrations);
	const at = now();
	database.db.exec(`
		INSERT OR IGNORE INTO app_settings (id, updated_at) VALUES ('default', 1);
		UPDATE app_settings SET agent_enabled = 1, agent_auto_read_enabled = 1, agent_external_auto_read_allowed = 1;
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES
			('user-1', 'owner@example.com', 'hash', 'Owner', 'admin', 1, 1),
			('user-2', 'reader@example.com', 'hash', 'Reader', 'user', 0, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'user-1', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES
			('mailbox-off', 'user-1', 'domain-1', 'private', 'shared', 1),
			('mailbox-on', 'user-1', 'domain-1', 'owner', 'personal', 1);
		INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES ('access-1', 'mailbox-off', 'user-2', 'read_only', 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, thread_id, created_at) VALUES
			('email-off', 'user-1', 'mailbox-off', 'inbound', 'customer@example.net', 'private@example.com', 'Offer ${MARKER}', 'Body ${MARKER}', 'received', 'thread-off', ${at}),
			('email-on', 'user-1', 'mailbox-on', 'inbound', 'friend@example.net', 'owner@example.com', 'Lunch', 'See you at noon?', 'received', 'thread-on', ${at});
	`);
	const requests = [];
	const server = createServer(async (request, response) => {
		let raw = "";
		for await (const part of request) raw += part;
		requests.push(raw);
		const body = JSON.parse(raw);
		if (body.stream) {
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			const chunk = (delta, finishReason = null) =>
				`data: ${JSON.stringify({ id: "mock-1", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
			response.write(chunk({ role: "assistant", content: "Noted." }));
			response.write(chunk({}, "stop"));
			return void response.end("data: [DONE]\n\n");
		}
		response.writeHead(200, { "Content-Type": "application/json" });
		response.end(
			JSON.stringify({
				id: "mock-1",
				object: "chat.completion",
				created: 1,
				model: "test-model",
				choices: [{ index: 0, message: { role: "assistant", content: "Noted." }, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			}),
		);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	const env = {
		DB: database,
		BUCKET: { get: async () => null, put: async () => null, delete: async () => {} },
		AGENT_QUEUE: { send: async () => undefined },
		AI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
		AI_API_KEY: "test-key",
		AI_MODEL: "test-model",
		AI_ALLOW_INSECURE_LOOPBACK: "1",
	};
	globalThis.__kiteNodeEnv = env;
	t.after(() => {
		delete globalThis.__kiteNodeEnv;
	});
	const tokens = { owner: await createSession(env, "user-1"), reader: await createSession(env, "user-2") };
	const request = (path, { method = "GET", as = "owner", body } = {}) =>
		new Request(`http://kite.local${path}`, {
			method,
			headers: {
				Origin: "http://kite.local",
				Authorization: `Bearer ${tokens[as]}`,
				...(body ? { "Content-Type": "application/json" } : {}),
			},
			...(body ? { body: JSON.stringify(body) } : {}),
		});
	const setAi = (mailboxId, aiDisabled, as = "owner") =>
		putMailboxAi(request("/api/agent/settings/ai", { method: "PUT", as, body: { mailboxId, aiDisabled } }));
	const chat = (mailboxId, text = "What is in my inbox?", conversationId = undefined) =>
		postAgentChat(request("/api/agent/chat", { method: "POST", body: { mailboxId, text, conversationId } }));
	const leaked = () => requests.filter((raw) => raw.includes(MARKER));
	return { database, env, requests, leaked, request, setAi, chat };
}

const drain = (response) => response.text();

test("before migration 0091 no mailbox has AI off and the switch answers 409 MIGRATION_PENDING", async (t) => {
	const before = copyMigrationsBefore(scratch, 91);
	const { env, setAi, chat } = await harness(t, { migrations: before });
	assert.deepEqual([...(await aiOffMailboxIds(env, ["mailbox-off", "mailbox-on"]))], []);
	const response = await setAi("mailbox-off", true);
	assert.equal(response.status, 409);
	assert.equal((await response.json()).code, "MIGRATION_PENDING");
	// Today's behaviour is kept: chat works in every mailbox.
	const answered = await chat("mailbox-off");
	assert.equal(answered.status, 200);
	await drain(answered);
});

test("turning No AI back off still saves before migration 0099 (R4 of review round 2)", async (t) => {
	// 0091/0092 are applied (the switch itself works) but 0099 (search by meaning) is not: `semantic_index`
	// does not exist on `mailbox_agent_settings` yet, which used to throw "no such column" (not "no such table",
	// so uncaught) out of `requeueMailboxSemanticIndex` and turn an otherwise-successful save into a 500.
	const before = copyMigrationsBefore(scratch, 99);
	const { setAi } = await harness(t, { migrations: before });
	const off = await setAi("mailbox-off", true);
	assert.equal(off.status, 200);
	const on = await setAi("mailbox-off", false);
	assert.equal(on.status, 200, await on.text());
});

test("only someone who can manage the mailbox changes the switch, with an audit row", async (t) => {
	const { database, setAi, requests } = await harness(t);
	const denied = await setAi("mailbox-off", true, "reader");
	assert.equal(denied.status, 403);
	assert.equal((await setAi("mailbox-off", true)).status, 200);
	assert.equal(
		database.db.prepare("SELECT ai_disabled AS off FROM mailbox_agent_settings WHERE mailbox_id = 'mailbox-off'").get()
			.off,
		1,
	);
	const audit = database.db
		.prepare("SELECT actor_user_id, mailbox_id, metadata FROM audit_logs WHERE action = 'agent.mailbox_ai'")
		.all();
	assert.deepEqual(audit, [{ actor_user_id: "user-1", mailbox_id: "mailbox-off", metadata: '{"aiDisabled":true}' }]);
	// Saving the same value again writes no second row; turning it on called no model.
	await setAi("mailbox-off", true);
	assert.equal(
		database.db.prepare("SELECT count(*) AS n FROM audit_logs WHERE action = 'agent.mailbox_ai'").get().n,
		1,
	);
	assert.equal(requests.length, 0);
});

test("turning it on stops queued jobs, expires suggestions and deletes stored summaries", async (t) => {
	const { database, env, setAi, requests } = await harness(t);
	const at = now();
	database.db.exec(`
		INSERT INTO agent_jobs (id, kind, mailbox_id, source_message_id, reviewer_user_id, next_attempt_at, created_at) VALUES
			('job-triage', 'triage', 'mailbox-off', 'email-off', 'user-1', 1, ${at}),
			('job-other', 'triage', 'mailbox-on', 'email-on', 'user-1', 1, ${at});
		INSERT INTO agent_suggestions (id, mailbox_id, message_id, reviewer_user_id, kind, title, created_at) VALUES
			('sugg-off', 'mailbox-off', 'email-off', 'user-1', 'summary', 'About ${MARKER}', ${at}),
			('sugg-on', 'mailbox-on', 'email-on', 'user-1', 'summary', 'Lunch', ${at});
		INSERT INTO ai_summaries (id, mailbox_id, kind, thread_key, message_id, text, coverage_digest, source, created_at, updated_at) VALUES
			('line-off', 'mailbox-off', 'line', 'thread-off', 'email-off', 'Line ${MARKER}', 'x', 'line_job', ${at}, ${at}),
			('line-on', 'mailbox-on', 'line', 'thread-on', 'email-on', 'Lunch at noon', 'x', 'line_job', ${at}, ${at}),
			('translation-off', 'mailbox-off', 'message_translation', 'thread-off', 'email-off', '{"segments":[]}', 'x', 'button', ${at}, ${at});
	`);
	assert.equal((await setAi("mailbox-off", true)).status, 200);
	const job = (id) => database.db.prepare("SELECT status, reason FROM agent_jobs WHERE id = ?").get(id);
	assert.deepEqual({ ...job("job-triage") }, { status: "skipped", reason: "mailbox_ai_off" });
	assert.equal(job("job-other").status, "pending");
	const status = (id) => database.db.prepare("SELECT status FROM agent_suggestions WHERE id = ?").get(id).status;
	assert.equal(status("sugg-off"), "expired");
	assert.equal(status("sugg-on"), "open");
	assert.deepEqual(
		database.db
			.prepare("SELECT id FROM ai_summaries ORDER BY id")
			.all()
			.map((row) => row.id),
		["line-on"],
	);
	assert.equal(requests.length, 0);
	// The lists stop showing anything from it even if a row slipped in after the switch.
	database.db
		.exec(`INSERT INTO ai_summaries (id, mailbox_id, kind, thread_key, message_id, text, coverage_digest, source, created_at, updated_at)
		VALUES ('late', 'mailbox-off', 'line', 'thread-off', 'email-off', 'Late ${MARKER}', 'x', 'line_job', ${at}, ${at});
		UPDATE mailbox_agent_settings SET list_summaries = 1;
		INSERT OR IGNORE INTO mailbox_agent_settings (mailbox_id, list_summaries, updated_at) VALUES ('mailbox-on', 1, 1);
		UPDATE agent_suggestions SET status = 'open' WHERE id = 'sugg-off';`);
	const lines = await loadRowLines(
		createDb(database),
		[
			{ id: "email-off", mailboxId: "mailbox-off" },
			{ id: "email-on", mailboxId: "mailbox-on" },
		],
		(row) => [row.id],
	);
	assert.deepEqual([lines("email-off"), lines("email-on")], [{}, { lineSummary: "Lunch at noon" }]);
	const listed = await listSuggestions(env, owner, { mailboxId: null, status: "open" });
	assert.deepEqual(
		listed.suggestions.map((row) => row.id),
		["sugg-on"],
	);
	assert.equal(listed.mailboxes.find((mailbox) => mailbox.id === "mailbox-off").autonomy, "off");
});

test("chat, Write with Kite and Summarize are refused for the mailbox and work in another one", async (t) => {
	const { env, setAi, chat, request, requests, leaked } = await harness(t);
	await setAi("mailbox-off", true);

	const refused = await chat("mailbox-off", "Summarize my inbox");
	assert.equal(refused.status, 403);
	assert.equal((await refused.json()).code, "mailbox_ai_off");
	const answered = await chat("mailbox-on");
	assert.equal(answered.status, 200);
	await drain(answered);
	assert.equal(requests.length, 1);

	const composeCheck = await (await getCompose(request("/api/agent/compose?mailboxId=mailbox-off"))).json();
	assert.deepEqual(composeCheck, { available: false, reason: "mailbox_ai_off" });
	assert.deepEqual(await (await getCompose(request("/api/agent/compose?mailboxId=mailbox-on"))).json(), {
		available: true,
	});
	await assert.rejects(
		createComposeStream(env, owner, {
			mailboxId: "mailbox-off",
			mode: "write",
			instruction: "Reply",
			inReplyTo: null,
			threadId: "thread-off",
		}),
		(error) => error.name === "InteractiveModelRefusedError" && error.reason === "mailbox_ai_off",
	);

	await assert.rejects(
		createSummary(env, owner, "email-off", { scope: "message", language: "en" }),
		(error) => error.code === "mailbox_ai_off" && error.status === 403,
	);
	const state = await getSummaryState(env, owner, "email-off", { scope: "message", language: "en" });
	assert.equal(state.reason, "mailbox_ai_off");
	assert.equal(state.summary, null);
	assert.deepEqual(leaked(), []);
});

test("queued and new automatic work for the mailbox is skipped when it starts, and nothing reaches the provider", async (t) => {
	const { database, env, setAi, requests } = await harness(t);
	const at = now();
	database.db.exec(`
		INSERT INTO mailbox_agent_settings (mailbox_id, auto_draft_enabled, autonomy, list_summaries, reviewer_user_id, updated_at)
		VALUES ('mailbox-off', 1, 'suggest', 1, 'user-1', 1);
	`);
	await setAi("mailbox-off", true);
	// Jobs queued before the switch whose skip raced it, retried, or put back by hand: checked again when they start.
	database.db.exec(`
		INSERT INTO agent_jobs (id, kind, mailbox_id, source_message_id, reviewer_user_id, next_attempt_at, created_at) VALUES
			('job-draft', 'draft', 'mailbox-off', 'email-off', 'user-1', 1, ${at}),
			('job-triage', 'triage', 'mailbox-off', 'email-off', 'user-1', 1, ${at} + 1),
			('job-line', 'line_summary', 'mailbox-off', 'email-off', 'user-1', 1, ${at} + 2);
	`);
	await processAgentDraftJob(env, "job-draft");
	await processAgentTriageJob(env, "job-triage");
	await processLineSummaryJob(env, "job-line");
	assert.deepEqual(
		database.db
			.prepare("SELECT id, status, reason FROM agent_jobs ORDER BY id")
			.all()
			.map((row) => ({ ...row })),
		[
			{ id: "job-draft", status: "skipped", reason: "mailbox_ai_off" },
			{ id: "job-line", status: "skipped", reason: "mailbox_ai_off" },
			{ id: "job-triage", status: "skipped", reason: "mailbox_ai_off" },
		],
	);
	database.db.exec("DELETE FROM agent_jobs");
	await scheduleAgentWork(env, { mailboxId: "mailbox-off", sourceMessageId: "email-off", ownerUserId: "user-1" });
	assert.equal(database.db.prepare("SELECT count(*) AS n FROM agent_jobs").get().n, 0);
	assert.equal(requests.length, 0);
});

test("the model selection itself refuses the mailbox, whatever path asks", async (t) => {
	const { env, setAi } = await harness(t);
	await setAi("mailbox-off", true);
	await assert.rejects(getAgentModel(env, { mailboxId: "mailbox-off" }), { name: "MailboxAiOffError" });
	assert.equal((await getAgentModel(env, { mailboxId: "mailbox-on" }))?.modelId, "test-model");
});

test("chat tools answer a plain refusal for a message of the mailbox and never show its subject or sender", async (t) => {
	const { env, setAi } = await harness(t);
	await setAi("mailbox-off", true);
	const context = { env, user: owner, mailboxId: "mailbox-on", origin: "chat" };
	await assert.rejects(runEmailTool(context, "get_email", { emailId: "email-off" }), {
		message: "AI is off for this mailbox",
	});
	await assert.rejects(runEmailTool(context, "get_thread", { emailId: "email-off" }), {
		message: "AI is off for this mailbox",
	});
	const searched = JSON.stringify(await runEmailTool(context, "search_emails", { query: MARKER }));
	assert.ok(!searched.includes(MARKER));
	const listed = JSON.stringify(await runEmailTool(context, "list_emails", {}));
	assert.ok(!listed.includes("email-off"));
	// Asked in the mailbox itself (a turn that was already running): the same refusal, for every tool.
	await assert.rejects(runEmailTool({ ...context, mailboxId: "mailbox-off" }, "list_emails", {}), {
		message: "AI is off for this mailbox",
	});
	// MCP serves the key's client directly, not an AI provider Kite calls: unaffected.
	const mcp = await runEmailTool({ ...context, mailboxId: "mailbox-off", origin: "mcp" }, "get_email", {
		emailId: "email-off",
	});
	assert.equal(mcp.id, "email-off");
});

test("the assistant settings report the switch, and turning it off again restores chat", async (t) => {
	const { setAi, chat, request } = await harness(t);
	await setAi("mailbox-off", true);
	const settings = await (await getAgentSettings(request("/api/agent/settings?mailboxId=mailbox-off"))).json();
	assert.equal(settings.aiDisabled, true);
	assert.equal(settings.aiSwitchReady, true);
	await setAi("mailbox-off", false);
	const answered = await chat("mailbox-off");
	assert.equal(answered.status, 200);
	await drain(answered);
});

const chatContext = (trigger = "chat") => ({
	viewer: { userId: "user-1", role: "admin", isPrimaryAdmin: true },
	requestId: "test",
	locale: "en",
	timeZone: "UTC",
	grants: [],
	mailboxIds: ["mailbox-on"],
	trigger,
});

test("a record is hidden when it was read from, or changed in, a mailbox with AI off; a lost id hides it", async (t) => {
	const { database, env, setAi } = await harness(t);
	await setAi("mailbox-off", true);
	database.db.exec(`INSERT INTO agent_actions (id, mailbox_id, initiator, action, status, after, created_at, updated_at)
		VALUES ('act-1', 'mailbox-off', 'user', 'finance.track_subscription', 'applied', '{"ref":{"kind":"finance:subscription","id":"sub-x"}}', 1, 1)`);
	assert.deepEqual(
		await aiHiddenSources(env, [
			{ mailboxIds: ["mailbox-on"], messageIds: ["email-on"] },
			{ mailboxIds: [null], messageIds: ["email-off"] },
			{ mailboxIds: ["mailbox-off"] },
			{ mailboxIds: ["mailbox-on"], refs: [{ kind: "finance:subscription", id: "sub-x" }] },
			{ messageIds: ["missing-message"] },
			{ mailboxIds: [""] },
			{},
		]),
		[false, true, true, true, true, true, false],
	);
	await assert.rejects(aiOffMailboxIds(env, ["mailbox-on", ""]), /mailbox id is missing/);
	// Only the chat asks: MCP and the API serve the key's own client.
	assert.deepEqual(await moduleHost.mail.aiHidden(chatContext("mcp"), [{ mailboxIds: ["mailbox-off"] }]), [false]);
	assert.deepEqual(await moduleHost.mail.aiHidden(chatContext(), [{ mailboxIds: ["mailbox-off"] }]), [true]);
});

test("Money Watch in the chat leaves out every subscription with anything from the mailbox, documents included", async (t) => {
	const { database, setAi } = await harness(t);
	await setAi("mailbox-off", true);
	database.db.exec(`
		INSERT INTO finance_subscriptions (id, user_id, mailbox_id, vendor, vendor_key, amount_minor, currency, cycle, source_message_id, last_message_id, created_at, updated_at) VALUES
			('sub-on', 'user-1', 'mailbox-on', 'Streamly', 'streamly', 999, 'EUR', 'monthly', 'email-on', NULL, 1, 1),
			('sub-off', 'user-1', 'mailbox-off', 'Offvendor ${MARKER}', 'offvendor', 500, 'EUR', 'monthly', 'email-off', NULL, 1, 1),
			('sub-mixed-doc', 'user-1', 'mailbox-on', 'Mixdoc', 'mixdoc', 100, 'EUR', 'monthly', 'email-on', NULL, 1, 1),
			('sub-mixed-last', 'user-1', 'mailbox-on', 'Mixlast', 'mixlast', 100, 'EUR', 'monthly', 'email-on', 'email-off', 1, 1),
			('sub-mixed-action', 'user-1', 'mailbox-on', 'Mixact', 'mixact', 100, 'EUR', 'monthly', NULL, NULL, 1, 1),
			('sub-manual', 'user-1', NULL, 'Gym', 'gym', 3000, 'EUR', 'monthly', NULL, NULL, 1, 1);
		INSERT INTO finance_charges (id, subscription_id, user_id, message_id, doc_type, amount_minor, currency, document_at, created_at) VALUES
			('doc-on', 'sub-on', 'user-1', 'email-on', 'invoice', 999, 'EUR', 1, 1),
			('doc-off', 'sub-mixed-doc', 'user-1', 'email-off', 'invoice', 4242, 'EUR', 1, 1);
		INSERT INTO agent_actions (id, mailbox_id, initiator, action, status, after, created_at, updated_at)
		VALUES ('act-1', 'mailbox-off', 'user', 'finance.track_subscription', 'applied', '{"ref":{"kind":"finance:subscription","id":"sub-mixed-action"}}', 1, 1);
	`);
	const chat = await listSubscriptionsTool({ status: "all" }, chatContext());
	assert.deepEqual(chat.subscriptions.map((row) => row.ref.id).sort(), ["sub-manual", "sub-on"]);
	assert.ok(!JSON.stringify(chat).includes(MARKER));
	assert.ok(!JSON.stringify(chat).includes("4242"));
	const mcp = await listSubscriptionsTool({ status: "all" }, chatContext("mcp"));
	assert.equal(mcp.subscriptions.length, 6);
});

test("Calendar in the chat leaves out events from the mailbox's invites; free time still counts them", async (t) => {
	const { database, env, setAi } = await harness(t);
	await setAi("mailbox-off", true);
	const start = Date.now() + 86_400_000;
	const at = (offsetHours) => Math.floor((start + offsetHours * 3_600_000) / 1000);
	database.db.exec(`
		INSERT INTO calendar_events (id, user_id, mailbox_id, source_message_id, title, description, location, attendees, starts_at, ends_at, created_at, updated_at) VALUES
			('evt-off', 'user-1', NULL, 'email-off', 'Board ${MARKER}', 'Agenda ${MARKER}', 'Room', '[]', ${at(1)}, ${at(2)}, 1, 1),
			('evt-mailbox', 'user-1', 'mailbox-off', NULL, 'Mailbox ${MARKER}', '', '', '[]', ${at(3)}, ${at(4)}, 1, 1),
			('evt-own', 'user-1', NULL, NULL, 'Dentist', '', '', '[]', ${at(5)}, ${at(6)}, 1, 1);
	`);
	const [user] = database.db.prepare("SELECT * FROM users WHERE id = 'user-1'").all();
	const context = {
		env,
		user: { ...owner, ...user, timeZone: "UTC" },
		timeZone: "UTC",
		aiHidden: (sources) => moduleHost.mail.aiHidden(chatContext(), sources),
	};
	const range = { start: new Date(start).toISOString(), end: new Date(start + 7 * 3_600_000).toISOString() };
	const schedule = await runCalendarTool(context, "get_schedule", range);
	assert.deepEqual(
		schedule.events.map((event) => event.id),
		["evt-own"],
	);
	const searched = await runCalendarTool(context, "search_events", { ...range, query: "NOAI", limit: 10 });
	assert.deepEqual(searched.events, []);
	await assert.rejects(runCalendarTool(context, "get_event", { eventId: "evt-off" }), /Event not found/);
	await assert.rejects(runCalendarTool(context, "delete_events", { eventIds: ["evt-off"] }), /Event not found/);
	const free = await runCalendarTool(context, "find_free_time", { ...range, durationMinutes: 60, limit: 10 });
	assert.ok(!JSON.stringify(free).includes(MARKER));
	assert.ok(
		free.slots.every((slot) => Date.parse(slot.endsAt) <= at(1) * 1000 || Date.parse(slot.startsAt) >= at(2) * 1000),
	);
	// The calendar page and MCP are unchanged.
	const page = await runCalendarTool({ ...context, aiHidden: undefined }, "get_schedule", range);
	assert.equal(page.events.length, 3);
});

test("earlier chat messages from before the switch are not sent again, and the chat in another mailbox goes on", async (t) => {
	const { database, chat, setAi, requests } = await harness(t);
	const first = await chat("mailbox-on", "Hello");
	const conversationId = first.headers.get("X-Conversation-Id");
	await drain(first);
	// An earlier answer that quoted the other mailbox, from before AI was turned off there.
	database.db.exec(`INSERT INTO agent_chat_messages (id, conversation_id, role, content, created_at)
		VALUES ('old-answer', '${conversationId}', 'assistant', 'Earlier: ${MARKER}', ${now() - 60})`);
	await setAi("mailbox-off", true);
	requests.length = 0;
	const answered = await chat("mailbox-on", "And now?", conversationId);
	assert.equal(answered.status, 200);
	await drain(answered);
	assert.equal(requests.length, 1);
	assert.ok(!requests[0].includes(MARKER));
	assert.ok(requests[0].includes("And now?"));
});

test("turning AI back on clears anything a racing request wrote while it was off", async (t) => {
	const { database, setAi } = await harness(t);
	await setAi("mailbox-off", true);
	const at = now();
	database.db.exec(`
		INSERT INTO ai_summaries (id, mailbox_id, kind, thread_key, message_id, text, coverage_digest, source, created_at, updated_at)
		VALUES ('raced', 'mailbox-off', 'line', 'thread-off', 'email-off', 'Raced ${MARKER}', 'x', 'line_job', ${at}, ${at});
		INSERT INTO agent_suggestions (id, mailbox_id, message_id, reviewer_user_id, kind, title, created_at)
		VALUES ('raced-sugg', 'mailbox-off', 'email-off', 'user-1', 'summary', 'Raced', ${at});
	`);
	await setAi("mailbox-off", false);
	assert.equal(database.db.prepare("SELECT count(*) AS n FROM ai_summaries").get().n, 0);
	assert.equal(
		database.db.prepare("SELECT status FROM agent_suggestions WHERE id = 'raced-sugg'").get().status,
		"expired",
	);
	assert.equal(
		database.db.prepare("SELECT count(*) AS n FROM audit_logs WHERE action = 'agent.mailbox_ai'").get().n,
		2,
	);
});

test("a model selected before the switch refuses its next call (a fallback, repair or later step)", async (t) => {
	const { env, setAi, requests } = await harness(t);
	const selection = await getAgentModel(env, { mailboxId: "mailbox-off" });
	await setAi("mailbox-off", true);
	await assert.rejects(
		selection.model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: MARKER }] }] }),
		{ name: "MailboxAiOffError" },
	);
	assert.equal(requests.length, 0);
});

test("a model selected before the switch refuses its next streamed call too, and streams while AI is on", async (t) => {
	const { env, setAi, requests } = await harness(t);
	const selection = await getAgentModel(env, { mailboxId: "mailbox-off" });
	const prompt = [{ role: "user", content: [{ type: "text", text: "Hello" }] }];
	const { stream } = await selection.model.doStream({ prompt });
	for await (const _part of stream);
	assert.equal(requests.length, 1);
	await setAi("mailbox-off", true);
	await assert.rejects(
		selection.model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: MARKER }] }] }),
		{ name: "MailboxAiOffError" },
	);
	assert.equal(requests.length, 1);
	assert.deepEqual(
		requests.filter((raw) => raw.includes(MARKER)),
		[],
	);
});

const stranger = { id: "user-3", email: "stranger@example.com", role: "user" };

test("the history cut is when the switch flipped, for people who can read that mailbox only", async (t) => {
	const { database, env, setAi } = await harness(t);
	database.db.exec(
		"INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('user-3', 'stranger@example.com', 'hash', 'Stranger', 'user', 1)",
	);
	assert.equal(await aiOffSince(env, owner), null);
	await setAi("mailbox-off", true);
	const since = await aiOffSince(env, owner);
	assert.ok(since instanceof Date);
	// A later settings save or a sender mute in that mailbox does not move it.
	database.db.exec(`UPDATE mailbox_agent_settings SET updated_at = updated_at + 3600,
		capabilities = json_set(capabilities, '$.mutedSenders', json('["noise@example.net"]')) WHERE mailbox_id = 'mailbox-off'`);
	assert.equal((await aiOffSince(env, owner)).getTime(), since.getTime());
	// Saving the same value again does not move it either.
	await setAi("mailbox-off", true);
	assert.equal((await aiOffSince(env, owner)).getTime(), since.getTime());
	// The read-only member can read it, the stranger cannot.
	assert.equal(
		(await aiOffSince(env, { id: "user-2", email: "reader@example.com", role: "user" })).getTime(),
		since.getTime(),
	);
	assert.equal(await aiOffSince(env, stranger), null);
	// Turning AI back on clears the time.
	await setAi("mailbox-off", false);
	assert.equal(await aiOffSince(env, owner), null);
	assert.equal(
		database.db.prepare("SELECT ai_disabled_at FROM mailbox_agent_settings WHERE mailbox_id = 'mailbox-off'").get()
			.ai_disabled_at,
		null,
	);
});

test("before 0092 the switch still saves and the cut falls back to the last settings save; 0092 takes the audit time", async (t) => {
	const before = copyMigrationsBefore(scratch, 92);
	const { database, env, setAi } = await harness(t, { migrations: before });
	assert.equal((await setAi("mailbox-off", true)).status, 200);
	const audit = database.db
		.prepare("SELECT created_at FROM audit_logs WHERE action = 'agent.mailbox_ai'")
		.get().created_at;
	database.db.exec("UPDATE mailbox_agent_settings SET updated_at = updated_at + 3600 WHERE mailbox_id = 'mailbox-off'");
	const saved = database.db
		.prepare("SELECT updated_at FROM mailbox_agent_settings WHERE mailbox_id = 'mailbox-off'")
		.get().updated_at;
	assert.equal((await aiOffSince(env, owner)).getTime(), saved * 1000);
	await applyMigrations(database, migrationsDir);
	assert.equal(
		database.db.prepare("SELECT ai_disabled_at FROM mailbox_agent_settings WHERE mailbox_id = 'mailbox-off'").get()
			.ai_disabled_at,
		audit,
	);
	assert.equal((await aiOffSince(env, owner)).getTime(), audit * 1000);
});

test("with no mailbox off nothing is looked up, and only actions taken in an AI-off mailbox hide a record", async (t) => {
	const { database, env, setAi } = await harness(t);
	database.db
		.exec(`INSERT INTO agent_actions (id, mailbox_id, initiator, action, status, after, created_at, updated_at) VALUES
		('act-on', 'mailbox-on', 'user', 'finance.track_subscription', 'applied', '{"ref":{"kind":"finance:subscription","id":"sub-on"}}', 1, 1),
		('act-off', 'mailbox-off', 'user', 'finance.track_subscription', 'applied', '{"ref":{"kind":"finance:subscription","id":"sub-off"}}', 1, 1)`);
	const sources = [
		{ refs: [{ kind: "finance:subscription", id: "sub-on" }] },
		{ refs: [{ kind: "finance:subscription", id: "sub-off" }] },
		{ messageIds: ["missing-message"] },
		{ mailboxIds: [""] },
	];
	assert.deepEqual(await aiHiddenSources(env, sources), [false, false, false, true]);
	await setAi("mailbox-off", true);
	assert.deepEqual(await aiHiddenSources(env, sources), [false, true, true, true]);
});
