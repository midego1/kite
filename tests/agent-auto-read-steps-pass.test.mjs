import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-agent-auto-read-steps-pass-");
after(() => rmSync(outDir, { recursive: true, force: true }));

/**
 * A module that exists only in this test, added to the four registries at bundle time, so the steps-only
 * pass, the refused-model path, the mailbox switch and the reviewer audience are checked without a real
 * module. Its automatic step records the input it gets and answers one reviewer-only suggestion.
 */
const TEST_MODULE_SOURCE = `
import { z } from "zod";
import { triageStepSchemas } from "./lib/modules/shared-schemas";

export const testManifest = {
	id: "stepmod", name: "Step test", description: "x", runtime: "builtin", dependsOn: [], defaultEnabled: true,
	pages: [], apiPrefixes: [], nav: [], commands: [], composerSlots: [], recordKinds: [], webhookEvents: [],
	grants: [], mcpScopes: [], apiKeyScopes: [], jmapCapabilities: [], searchSections: [], messageStatuses: [],
	queueMessageTypes: [], cronTasks: [], actionLabels: {}, reasonTexts: { "module_disabled:stepmod": "Step test is turned off" },
};
export const testCapabilities = {
	moduleId: "stepmod",
	promptFragment: null,
	descriptors: [
		{ name: "scan", surfaces: ["triage_step"], description: "x", inputSchema: {}, effect: "read",
			triage: { order: 30, automatic: true, capability: "gadgets" } },
		{ name: "gadgetNote", surfaces: ["suggestion_kind"], description: "x", inputSchema: {}, effect: "none",
			suggestionKind: { kind: "gadget_note", label: "Gadget", reasonTemplate: "gadget", audience: "reviewer" } },
	],
};
export const testServer = {
	handlers: {
		async scan(input) {
			(globalThis.__stepInputs ??= []).push(input);
			return { suggestions: [{ kind: "gadget_note", payload: { subject: input.message.subject }, reason: "gadget", title: "Gadget found" }] };
		},
	},
	schemas: { scan: triageStepSchemas, gadgetNote: { input: z.object({ subject: z.string().nullable() }) } },
};
`;
const REGISTRY_TAILS = {
	"client-data/module-ids.ts": `\n(MODULE_IDS as string[]).push("stepmod");\n`,
	"registry.ts": `\nimport { testManifest } from "stepmod:test";\n(MODULE_MANIFESTS as unknown[]).push(testManifest);\n`,
	"capability-registry.ts": `\nimport { testCapabilities } from "stepmod:test";\n(MODULE_CAPABILITIES as unknown[]).push(testCapabilities);\n`,
	"server-registry.ts": `\nimport { testServer } from "stepmod:test";\n(SERVER_MODULES as Record<string, unknown>).stepmod = testServer;\n`,
};
const injectTestModule = {
	name: "inject-test-module",
	setup(build) {
		build.onResolve({ filter: /^stepmod:test$/ }, () => ({ path: "stepmod", namespace: "stepmod" }));
		build.onLoad({ filter: /.*/, namespace: "stepmod" }, () => ({
			contents: TEST_MODULE_SOURCE,
			loader: "js",
			resolveDir: join(root, "src"),
		}));
		build.onLoad({ filter: /src[\\/]lib[\\/]modules[\\/].*\.ts$/ }, async (args) => {
			const tail = REGISTRY_TAILS[relative(join(root, "src/lib/modules"), args.path).replaceAll("\\", "/")];
			if (!tail) return undefined;
			return { contents: (await readFile(args.path, "utf8")) + tail, loader: "ts" };
		});
	},
};

await build({
	entryPoints: {
		process: join(root, "src/lib/agent/auto-read/process.ts"),
		schedule: join(root, "src/lib/agent/auto-read/schedule.ts"),
		api: join(root, "src/lib/agent/auto-read/suggestion-api.ts"),
		badges: join(root, "src/lib/agent/auto-read/message-suggestions.ts"),
		visibility: join(root, "src/lib/agent/auto-read/suggestion-visibility.ts"),
		activity: join(root, "src/lib/agent/auto-read/activity.ts"),
		state: join(root, "src/lib/modules/state.ts"),
		database: join(root, "src/db/index.ts"),
		runtime: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	// One copy of the registries and the module state cache across the entries.
	splitting: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	packages: "external",
	tsconfig: join(root, "tsconfig.json"),
	alias: { "cloudflare:workers": join(root, "server/runtime/cloudflare-workers.ts") },
	plugins: [injectTestModule],
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { processAgentTriageJob } = await load("process");
const { scheduleAgentWork } = await load("schedule");
const { listSuggestions, dismissSuggestion } = await load("api");
const { loadRowSuggestions } = await load("badges");
const { suggestionVisibilityFor } = await load("visibility");
const { listAgentActivity } = await load("activity");
const { clearModuleStateCache } = await load("state");
const { getDb } = await load("database");
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");

const nowSeconds = () => Math.floor(Date.now() / 1000);
const benign = {
	category: "fyi",
	needsReply: false,
	urgency: "low",
	summary: "The figures are attached.",
	tasks: [],
	suspicious: { flagged: false, reasons: [] },
};

let requests = [];
const realFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = realFetch;
});
beforeEach(() => {
	requests = [];
	globalThis.__stepInputs = [];
	globalThis.fetch = async (url, init) => {
		const body = JSON.parse(init.body);
		requests.push({ url: String(url), body });
		return Response.json({
			id: "chatcmpl-1",
			object: "chat.completion",
			created: 0,
			model: body.model,
			choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(benign) }, finish_reason: "stop" }],
			usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
		});
	};
});

const owner = { id: "owner", role: "user", isPrimaryAdmin: false, email: "owner@example.com", timeZone: "UTC" };
const colleague = {
	id: "colleague",
	role: "user",
	isPrimaryAdmin: false,
	email: "colleague@example.com",
	timeZone: "UTC",
};

async function setup(t, { externalAllowed = 1, rateLimited = false } = {}) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, join(root, "drizzle/migrations"));
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Owner', 1);
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('colleague', 'colleague@example.com', 'hash', 'Colleague', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'a', 'shared', 1);
		INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES ('share-1', 'mailbox-a', 'colleague', 'full_access', 1);
		INSERT INTO mailbox_agent_settings (mailbox_id, enabled, autonomy, reviewer_user_id, updated_at) VALUES ('mailbox-a', 1, 'suggest', 'owner', 1);
		INSERT OR IGNORE INTO app_settings (id, updated_at) VALUES ('default', 1);
	`);
	db.db
		.prepare(
			"UPDATE app_settings SET agent_enabled = 1, agent_auto_read_enabled = 1, agent_external_auto_read_allowed = ?, agent_provider = 'compatible', agent_preset = 'custom', agent_base_url = 'https://model.test/v1', agent_api_key = 'test-key', agent_model = 'fake-triage, fake-draft', agent_model_rates = ?",
		)
		.run(externalAllowed, JSON.stringify({ "fake-triage": { input: 0.05, output: 0.3 } }));
	const raw = new Map();
	const sent = [];
	const env = {
		DB: db,
		AGENT_QUEUE: { send: async (message) => void sent.push(message) },
		...(rateLimited ? { AGENT_RATE_LIMIT: { limit: async () => ({ success: false }) } } : {}),
		BUCKET: {
			get: async (key) => {
				if (!raw.has(key)) return null;
				const bytes = new TextEncoder().encode(raw.get(key));
				return { size: bytes.byteLength, arrayBuffer: async () => bytes.buffer };
			},
		},
	};
	globalThis.__kiteNodeEnv = env;
	clearModuleStateCache();
	t.after(() => {
		delete globalThis.__kiteNodeEnv;
		clearModuleStateCache();
	});
	return { db, env, raw, sent };
}

let count = 0;
/** A received message whose raw headers are stored, plus a pending triage job for it. */
function insertMessage(
	db,
	raw,
	{ headers = {}, text = `Could you send the figures? ${"x".repeat(1_600)}`, job = true } = {},
) {
	const id = `message-${++count}`;
	const rawKey = `raw/${id}`;
	const headerLines = Object.entries({
		From: "Vendor Billing <billing@vendor.test>",
		Subject: `Note ${id}`,
		...headers,
	})
		.map(([name, value]) => `${name}: ${value}`)
		.join("\r\n");
	raw.set(rawKey, `${headerLines}\r\n\r\n${text}`);
	db.db
		.prepare(
			"INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, spam_verdict, raw_r2_key, created_at) VALUES (?, 'owner', 'mailbox-a', 'inbound', 'Vendor Billing <billing@vendor.test>', 'a@example.com', ?, ?, 'received', 'inbox', ?, ?)",
		)
		.run(id, `Note ${id}`, text, rawKey, nowSeconds());
	if (!job) return { messageId: id };
	const jobId = `job-${count}`;
	db.db
		.prepare(
			"INSERT INTO agent_jobs (id, mailbox_id, source_message_id, reviewer_user_id, kind, status, next_attempt_at, created_at) VALUES (?, 'mailbox-a', ?, 'owner', 'triage', 'pending', 1, ?)",
		)
		.run(jobId, id, nowSeconds());
	return { jobId, messageId: id };
}

const AUTOMATIC = { "Auto-Submitted": "auto-generated" };
const INVITE = [
	"BEGIN:VCALENDAR",
	"VERSION:2.0",
	"METHOD:REQUEST",
	"BEGIN:VEVENT",
	"UID:uid-steps@partner.test",
	"DTSTAMP:20300101T000000Z",
	"DTSTART:20300312T100000Z",
	"DTEND:20300312T110000Z",
	"SUMMARY:Planning",
	"ORGANIZER:mailto:billing@vendor.test",
	"SEQUENCE:0",
	"END:VEVENT",
	"END:VCALENDAR",
	"",
].join("\r\n");
function attachInvite(db, raw, messageId) {
	raw.set(`att/${messageId}`, INVITE);
	db.db
		.prepare(
			"INSERT INTO message_attachments (id, message_id, filename, content_type, size, r2_key, created_at) VALUES (?, ?, 'invite.ics', 'text/calendar', ?, ?, 1)",
		)
		.run(`att-${messageId}`, messageId, INVITE.length, `att/${messageId}`);
}
const jobOf = (db, id) => db.db.prepare("SELECT status, reason FROM agent_jobs WHERE id = ?").get(id);
const kindsOf = (db, messageId) =>
	db.db
		.prepare("SELECT kind FROM agent_suggestions WHERE message_id = ? ORDER BY kind")
		.all(messageId)
		.map((row) => row.kind);
// A shared mailbox has the calendar switch off by default; these tests turn it on.
const setModuleSwitch = (db, value) =>
	db.db
		.prepare("UPDATE mailbox_agent_settings SET capabilities = ? WHERE mailbox_id = 'mailbox-a'")
		.run(JSON.stringify({ calendar: true, modules: { gadgets: value } }));
function setModule(db, enabled) {
	db.db
		.prepare(
			"INSERT INTO module_settings (id, module_id, enabled, updated_at) VALUES ('stepmod', 'stepmod', ?, 1) ON CONFLICT (module_id) DO UPDATE SET enabled = excluded.enabled",
		)
		.run(enabled ? 1 : 0);
	clearModuleStateCache();
}
const schedule = (env, messageId, headers) =>
	scheduleAgentWork(env, {
		mailboxId: "mailbox-a",
		sourceMessageId: messageId,
		ownerUserId: "owner",
		sender: "Vendor Billing <billing@vendor.test>",
		headers,
		status: "received",
		folderId: null,
	});
const triageJobsFor = (db, messageId) =>
	db.db.prepare("SELECT id FROM agent_jobs WHERE source_message_id = ? AND kind = 'triage'").all(messageId).length;

test("Auto-Submitted mail gets a triage job only while an opted-in step is on for the reviewer and the mailbox", async (t) => {
	const { db, env, raw } = await setup(t);
	const on = insertMessage(db, raw, { headers: AUTOMATIC, job: false });
	await schedule(env, on.messageId, AUTOMATIC);
	assert.equal(triageJobsFor(db, on.messageId), 1);

	setModule(db, false);
	const off = insertMessage(db, raw, { headers: AUTOMATIC, job: false });
	await schedule(env, off.messageId, AUTOMATIC);
	assert.equal(triageJobsFor(db, off.messageId), 0, "module off: today's gate");

	setModule(db, true);
	setModuleSwitch(db, false);
	const switched = insertMessage(db, raw, { headers: AUTOMATIC, job: false });
	await schedule(env, switched.messageId, AUTOMATIC);
	assert.equal(triageJobsFor(db, switched.messageId), 0, "mailbox switch off");

	const person = insertMessage(db, raw, { job: false });
	await schedule(env, person.messageId, {});
	assert.equal(triageJobsFor(db, person.messageId), 1, "mail a person wrote is triaged as before");
});

test("a steps-only pass runs only the opted-in step, makes no model request and plans no core kinds", async (t) => {
	const { db, env, raw } = await setup(t);
	const { jobId, messageId } = insertMessage(db, raw, {
		headers: {
			...AUTOMATIC,
			"List-Unsubscribe": "<https://vendor.test/u/1>",
			"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
		},
	});
	// The invitation step did not opt in to automatic mail, so it does not run on this pass.
	setModuleSwitch(db, true);
	attachInvite(db, raw, messageId);
	await processAgentTriageJob(env, jobId);
	assert.deepEqual(jobOf(db, jobId), { status: "completed", reason: null });
	assert.equal(requests.length, 0, "no model request on a steps-only pass");
	assert.deepEqual(kindsOf(db, messageId), ["gadget_note"]);
	const [input] = globalThis.__stepInputs;
	assert.equal(input.message.fromName, "Vendor Billing");
	assert.match(input.message.textExcerpt, /^Could you send the figures\?/);
	assert.equal(input.facts.automatic, true);
	assert.equal(input.facts.spam, false);
	assert.deepEqual(input.headers, {
		listUnsubscribe: "<https://vendor.test/u/1>",
		listUnsubscribePost: "List-Unsubscribe=One-Click",
		listId: null,
	});
	const [title] = db.db.prepare("SELECT title FROM agent_suggestions WHERE message_id = ?").all(messageId);
	assert.equal(title.title, "Gadget found");
});

test("steps-only jobs count toward the mailbox's daily triage limit", async (t) => {
	const { db, env, raw } = await setup(t);
	db.db.exec("UPDATE mailbox_agent_settings SET auto_read_daily_limit = 1 WHERE mailbox_id = 'mailbox-a'");
	const first = insertMessage(db, raw, { headers: AUTOMATIC });
	await processAgentTriageJob(env, first.jobId);
	assert.equal(jobOf(db, first.jobId).status, "completed");
	const second = insertMessage(db, raw, { headers: AUTOMATIC });
	await processAgentTriageJob(env, second.jobId);
	assert.deepEqual(jobOf(db, second.jobId), { status: "skipped", reason: "daily_limit" });
});

test("a full pass still asks the model and runs every due step", async (t) => {
	const { db, env, raw } = await setup(t);
	const { jobId, messageId } = insertMessage(db, raw);
	await processAgentTriageJob(env, jobId);
	assert.deepEqual(jobOf(db, jobId), { status: "completed", reason: null });
	assert.equal(requests.length, 1);
	assert.ok(globalThis.__stepInputs[0].model, "the step sees the model's answer");
	assert.ok(kindsOf(db, messageId).includes("gadget_note"));
	assert.ok(kindsOf(db, messageId).includes("summary"));
});

for (const [name, options, prepare, reason] of [
	["the external provider is not allowed", { externalAllowed: 0 }, () => undefined, "external_provider_not_allowed"],
	["the rate limit is exhausted", { rateLimited: true }, () => undefined, "rate_limited"],
	[
		"the spend cap is reached",
		{},
		(db) => db.db.exec("UPDATE mailbox_agent_settings SET daily_spend_cap_micros = 1 WHERE mailbox_id = 'mailbox-a'"),
		"spend_cap",
	],
])
	test(`when ${name}, module steps still run with model null and the job notes the skip`, async (t) => {
		const { db, env, raw } = await setup(t, options);
		prepare(db);
		const { jobId, messageId } = insertMessage(db, raw);
		await processAgentTriageJob(env, jobId);
		assert.deepEqual(jobOf(db, jobId), { status: "completed", reason });
		assert.equal(globalThis.__stepInputs.length, 1);
		assert.equal(globalThis.__stepInputs[0].model, null);
		assert.deepEqual(kindsOf(db, messageId), ["gadget_note"]);

		// With no step due, the job is skipped with the reason as before.
		setModuleSwitch(db, false);
		const other = insertMessage(db, raw);
		await processAgentTriageJob(env, other.jobId);
		assert.deepEqual(jobOf(db, other.jobId), { status: "skipped", reason });
		assert.deepEqual(kindsOf(db, other.messageId), []);

		const activity = await listAgentActivity(env, "mailbox-a", "owner");
		assert.deepEqual(
			activity.skippedJobs.map((job) => job.reason),
			[reason, reason],
		);
	});

test("a calendar invitation is still detected when the model is refused", async (t) => {
	const { db, env, raw } = await setup(t, { externalAllowed: 0 });
	setModuleSwitch(db, false);
	const { jobId, messageId } = insertMessage(db, raw);
	attachInvite(db, raw, messageId);
	await processAgentTriageJob(env, jobId);
	assert.deepEqual(jobOf(db, jobId), { status: "completed", reason: "external_provider_not_allowed" });
	assert.equal(requests.length, 0);
	assert.deepEqual(kindsOf(db, messageId), ["calendar_invite"]);
});

test("a reviewer-only suggestion is listed, counted, badged and decidable for the reviewer only", async (t) => {
	const { db, env, raw } = await setup(t);
	const { jobId, messageId } = insertMessage(db, raw, { headers: AUTOMATIC });
	await processAgentTriageJob(env, jobId);
	const [{ id }] = db.db.prepare("SELECT id FROM agent_suggestions WHERE message_id = ?").all(messageId);

	const forOwner = await listSuggestions(env, owner, { mailboxId: null, status: "open" });
	assert.deepEqual(
		forOwner.suggestions.map((row) => row.kind),
		["gadget_note"],
	);
	assert.deepEqual(forOwner.kindTotals, { gadget_note: 1 });
	const forColleague = await listSuggestions(env, colleague, { mailboxId: "mailbox-a", status: "open" });
	assert.deepEqual(forColleague.suggestions, []);
	assert.deepEqual(forColleague.kindTotals, {});
	assert.equal(forColleague.total, 0);

	const mailboxes = [{ id: "mailbox-a", permission: "full_access" }];
	const rows = [{ id: messageId, mailboxId: "mailbox-a", threadId: null }];
	const badge = async (user) =>
		(await loadRowSuggestions(getDb(env), mailboxes, rows, new Map(), await suggestionVisibilityFor(env, user)))(
			messageId,
		).agentSuggestions ?? [];
	assert.equal((await badge(owner)).length, 1);
	assert.deepEqual(await badge(colleague), []);

	await assert.rejects(dismissSuggestion(env, colleague, id, {}), (error) => error.status === 404);
	const dismissed = await dismissSuggestion(env, owner, id, {});
	assert.equal(dismissed.status, "dismissed");
});
