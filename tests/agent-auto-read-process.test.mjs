import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { REPAIR_MARKER, TRIAGE_SYSTEM_MARKER } from "../src/lib/agent/auto-read/request-markers.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-agent-auto-read-process-");
after(() => rmSync(outDir, { recursive: true, force: true }));

// import.meta.resolve (rather than a joined path) lets knip see which modules this test uses. No source
// maps: the bundle pulls in much of the app, and mapped zero-hit copies would distort the coverage gate.
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
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { processAgentTriageJob } = await load("process");
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");

const nowSeconds = () => Math.floor(Date.now() / 1000);
const benign = {
	category: "fyi",
	needsReply: false,
	urgency: "none",
	summary: "The quarterly figures are published.",
	tasks: [],
	suspicious: { flagged: false, reasons: [] },
};
const reply = (content, finishReason = "stop") => ({ content, finishReason });

/** Model replies, consumed in order; each entry is a reply or an HTTP status for an error. */
let replies = [];
let requests = [];
const realFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = realFetch;
});
beforeEach(() => {
	replies = [];
	requests = [];
	globalThis.fetch = async (url, init) => {
		const body = JSON.parse(init.body);
		requests.push({ url: String(url), body });
		const next = replies.shift() ?? reply(JSON.stringify(benign));
		if (typeof next === "number")
			return new Response(JSON.stringify({ error: { message: "upstream failure" } }), {
				status: next,
				headers: { "Content-Type": "application/json" },
			});
		return Response.json({
			id: "chatcmpl-1",
			object: "chat.completion",
			created: 0,
			model: body.model,
			choices: [{ index: 0, message: { role: "assistant", content: next.content }, finish_reason: next.finishReason }],
			usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
		});
	};
});

async function setup(t, { rates = { "fake-triage": { input: 0.05, output: 0.3 } }, externalAllowed = 1 } = {}) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, join(root, "drizzle/migrations"));
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Owner', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'a', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-b', 'owner', 'domain-1', 'b', 1);
		INSERT INTO mailbox_agent_settings (mailbox_id, enabled, autonomy, updated_at) VALUES ('mailbox-a', 1, 'suggest', 1);
		INSERT INTO mailbox_agent_settings (mailbox_id, enabled, autonomy, updated_at) VALUES ('mailbox-b', 1, 'suggest', 1);
		INSERT OR IGNORE INTO app_settings (id, updated_at) VALUES ('default', 1);
	`);
	db.db
		.prepare(
			"UPDATE app_settings SET agent_enabled = 1, agent_auto_read_enabled = 1, agent_external_auto_read_allowed = ?, agent_provider = 'compatible', agent_preset = 'custom', agent_base_url = 'https://model.test/v1', agent_api_key = 'test-key', agent_model = 'fake-triage, fake-draft', agent_model_rates = ?",
		)
		.run(externalAllowed, JSON.stringify(rates));
	const sent = [];
	const raw = new Map();
	const env = {
		DB: db,
		AGENT_QUEUE: { send: async (message, options) => void sent.push({ message, options }) },
		BUCKET: {
			get: async (key) =>
				raw.has(key) ? { arrayBuffer: async () => new TextEncoder().encode(raw.get(key)).buffer } : null,
		},
	};
	return { db, env, sent, raw };
}

let count = 0;
function insertJob(
	db,
	{
		text = "Could you send the figures?",
		spamVerdict = "inbox",
		rawR2Key = null,
		from,
		mailboxId = "mailbox-a",
		kind = "triage",
		status = "pending",
		reviewer = "owner",
	} = {},
) {
	const id = `message-${++count}`;
	db.db
		.prepare(
			"INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, spam_verdict, raw_r2_key, created_at) VALUES (?, 'owner', ?, 'inbound', ?, 'a@example.com', 'Figures', ?, 'received', ?, ?, ?)",
		)
		.run(id, mailboxId, from ?? "Customer <customer@example.net>", text, spamVerdict, rawR2Key, nowSeconds());
	const jobId = `job-${count}`;
	db.db
		.prepare(
			"INSERT INTO agent_jobs (id, mailbox_id, source_message_id, reviewer_user_id, kind, status, next_attempt_at, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
		)
		.run(jobId, mailboxId, id, reviewer, kind, status, nowSeconds(), status === "completed" ? nowSeconds() : null);
	return { jobId, messageId: id };
}

const jobOf = (db, id) =>
	db.db
		.prepare("SELECT status, reason, attempts, next_attempt_at AS nextAttemptAt FROM agent_jobs WHERE id = ?")
		.get(id);
const suggestionsOf = (db, messageId) =>
	db.db
		.prepare(
			"SELECT kind, status, title, payload, model, job_id AS jobId FROM agent_suggestions WHERE message_id = ? ORDER BY kind",
		)
		.all(messageId)
		.map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
const makeDue = (db, jobId) => db.db.prepare("UPDATE agent_jobs SET next_attempt_at = 1 WHERE id = ?").run(jobId);

test("triage sends no tools, wraps the mail, and stores summary and phishing suggestions with reason and model", async (t) => {
	const { db, env } = await setup(t);
	const { jobId, messageId } = insertJob(db, {
		text: `Please confirm. ${"x".repeat(1_600)}`,
		spamVerdict: "suspicious",
	});
	replies = [
		reply(
			JSON.stringify({
				...benign,
				summary: "The sender asks you to confirm your password.",
				suspicious: { flagged: true, reasons: ["credential_request"] },
			}),
		),
	];
	await processAgentTriageJob(env, jobId);
	assert.equal(jobOf(db, jobId).status, "completed");
	assert.equal(requests.length, 1);
	const [{ url, body }] = requests;
	assert.equal(url, "https://model.test/v1/chat/completions");
	assert.ok(!("tools" in body) && !("tool_choice" in body), "no tools on the automatic path");
	assert.deepEqual(body.response_format, { type: "json_object" });
	assert.equal(body.max_tokens, 400);
	assert.ok(!("reasoning_effort" in body));
	assert.equal(body.model, "fake-triage");
	assert.ok(body.messages[0].content.includes(TRIAGE_SYSTEM_MARKER));
	assert.match(body.messages[1].content, new RegExp(`<<<EMAIL id=${messageId} nonce=(\\w+)>>>[\\s\\S]*<<<END \\1>>>`));
	assert.deepEqual(suggestionsOf(db, messageId), [
		{
			kind: "phishing",
			status: "open",
			title: "This message looks like phishing",
			payload: { reasons: ["suspicious_verdict", "credential_request"], reason: "phishing_signals" },
			model: "fake-triage",
			jobId,
		},
		{
			kind: "summary",
			status: "open",
			title: "Summary",
			payload: { text: "The sender asks you to confirm your password.", reason: "long_thread" },
			model: "fake-triage",
			jobId,
		},
	]);
	const usage = db.db
		.prepare("SELECT source, mailbox_id, job_id, reserved, input_tokens, output_tokens FROM ai_usage")
		.all();
	assert.deepEqual(usage, [
		{
			source: "auto_triage",
			mailbox_id: "mailbox-a",
			job_id: jobId,
			reserved: 0,
			input_tokens: 120,
			output_tokens: 30,
		},
	]);
});

test("a per-model reasoning hint is sent with the 1500-token budget", async (t) => {
	const { db, env } = await setup(t, {
		rates: { "fake-triage": { input: 0.05, output: 0.3, reasoningEffort: "minimal" } },
	});
	const { jobId } = insertJob(db);
	await processAgentTriageJob(env, jobId);
	assert.equal(jobOf(db, jobId).status, "completed");
	assert.equal(requests[0].body.reasoning_effort, "minimal");
	assert.equal(requests[0].body.max_tokens, 1_500);
});

test("a length finish fails the attempt without parsing or repair, and the retry succeeds", async (t) => {
	const { db, env, sent } = await setup(t);
	const { jobId, messageId } = insertJob(db, { text: `Long ${"y".repeat(1_600)}` });
	// Complete, valid JSON: only the finish reason says it was cut off, so parsing it would have succeeded.
	replies = [reply(JSON.stringify(benign), "length")];
	const before = nowSeconds();
	await processAgentTriageJob(env, jobId);
	const failed = jobOf(db, jobId);
	assert.equal(failed.status, "pending");
	assert.equal(failed.attempts, 1);
	assert.match(failed.reason, /output tokens/);
	assert.ok(failed.nextAttemptAt >= before + 4 && failed.nextAttemptAt <= before + 6, "first backoff is 5 s");
	assert.equal(requests.length, 1, "no repair request");
	assert.deepEqual(suggestionsOf(db, messageId), []);
	assert.deepEqual(sent, [{ message: { kind: "agent.triage", jobId }, options: { delaySeconds: 6 } }]);

	makeDue(db, jobId);
	await processAgentTriageJob(env, jobId);
	assert.equal(jobOf(db, jobId).status, "completed");
	assert.equal(requests.length, 2);
	assert.equal(suggestionsOf(db, messageId).length, 1);
});

test("invalid output is repaired once per attempt and the job fails after three attempts", async (t) => {
	const { db, env, sent } = await setup(t);
	const { jobId, messageId } = insertJob(db);
	replies = Array.from({ length: 6 }, () => reply("not json {category: other"));
	const before = nowSeconds();
	await processAgentTriageJob(env, jobId);
	makeDue(db, jobId);
	await processAgentTriageJob(env, jobId);
	const second = jobOf(db, jobId);
	assert.ok(second.nextAttemptAt >= before + 9 && second.nextAttemptAt <= before + 11, "second backoff is 10 s");
	makeDue(db, jobId);
	await processAgentTriageJob(env, jobId);
	const job = jobOf(db, jobId);
	assert.equal(job.status, "failed");
	assert.equal(job.attempts, 3);
	assert.match(job.reason, /valid triage object/);
	assert.equal(requests.length, 6);
	assert.deepEqual(
		requests.map(({ body }) => body.messages.at(-1).content.startsWith(REPAIR_MARKER)),
		[false, true, false, true, false, true],
	);
	assert.deepEqual(suggestionsOf(db, messageId), []);
	assert.deepEqual(
		sent.map(({ options }) => options.delaySeconds),
		[6, 11],
	);
	makeDue(db, jobId);
	await processAgentTriageJob(env, jobId);
	assert.equal(requests.length, 6, "a failed job is not claimed again");
});

test("an HTTP error is one request per attempt, with no SDK retries", async (t) => {
	const { db, env } = await setup(t);
	const { jobId } = insertJob(db);
	replies = [500];
	await processAgentTriageJob(env, jobId);
	assert.equal(requests.length, 1);
	assert.equal(jobOf(db, jobId).status, "pending");
});

test("an external provider without the opt-in, or a spend cap, receives nothing", async (t) => {
	const blocked = await setup(t, { externalAllowed: 0 });
	const first = insertJob(blocked.db);
	await processAgentTriageJob(blocked.env, first.jobId);
	assert.deepEqual(jobOf(blocked.db, first.jobId).reason, "external_provider_not_allowed");

	const capped = await setup(t);
	capped.db.exec("UPDATE app_settings SET agent_daily_spend_cap_micros = 0");
	const second = insertJob(capped.db);
	await processAgentTriageJob(capped.env, second.jobId);
	assert.deepEqual(jobOf(capped.db, second.jobId), {
		status: "skipped",
		reason: "spend_cap",
		attempts: 1,
		nextAttemptAt: 1,
	});
	assert.equal(requests.length, 0);
});

test("list mail is settled from its raw headers without a model request", async (t) => {
	const { db, env, raw } = await setup(t);
	raw.set(
		"raw/list",
		"From: Team <team@lists.example.net>\r\nList-Id: <team.lists.example.net>\r\nSubject: News\r\n\r\nBody",
	);
	const { jobId } = insertJob(db, { rawR2Key: "raw/list", from: "Team <team@lists.example.net>" });
	await processAgentTriageJob(env, jobId);
	assert.equal(jobOf(db, jobId).status, "completed");
	assert.equal(requests.length, 0);
});

test("Workers AI gets JSON mode through the SDK and thinking off, and fenced JSON is accepted", async (t) => {
	const { db, env } = await setup(t);
	db.db.exec("UPDATE app_settings SET agent_provider = 'cloudflare', agent_model = '@cf/test/model'");
	const runs = [];
	env.AI = {
		run: async (model, inputs) => {
			runs.push({ model, inputs });
			return {
				choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(benign)}\n\`\`\`` }, finish_reason: "stop" }],
				usage: { prompt_tokens: 50, completion_tokens: 20 },
			};
		},
	};
	const { jobId } = insertJob(db);
	await processAgentTriageJob(env, jobId);
	assert.equal(jobOf(db, jobId).status, "completed");
	assert.equal(runs.length, 1, "fenced JSON needs no repair");
	const [{ model, inputs }] = runs;
	assert.equal(model, "@cf/test/model");
	assert.equal(inputs.response_format.type, "json_schema");
	assert.ok(inputs.response_format.json_schema.properties.category);
	assert.deepEqual(inputs.chat_template_kwargs, { thinking: false });
	assert.equal(inputs.max_tokens, 400);
	assert.equal(inputs.tools, undefined);
	assert.equal(inputs.reasoning_effort, undefined);
});

const usageOfJob = (db, jobId) =>
	db.db.prepare("SELECT mailbox_id, source, reserved FROM ai_usage WHERE job_id = ?").all(jobId);

test("the master switch, the kill switch and a pause skip without a model request", async (t) => {
	const cases = [
		["UPDATE app_settings SET agent_enabled = 0", "assistant_disabled"],
		["UPDATE app_settings SET agent_auto_read_enabled = 0", "kill_switch"],
		[`UPDATE mailbox_agent_settings SET paused_until = ${nowSeconds() + 86_400}`, "paused"],
	];
	for (const [statement, reason] of cases) {
		const { db, env } = await setup(t);
		db.db.exec(statement);
		const { jobId } = insertJob(db);
		await processAgentTriageJob(env, jobId);
		assert.deepEqual([jobOf(db, jobId).status, jobOf(db, jobId).reason], ["skipped", reason]);
		assert.deepEqual(usageOfJob(db, jobId), []);
	}
	assert.equal(requests.length, 0);
});

test("a pause that has ended no longer blocks triage", async (t) => {
	const { db, env } = await setup(t);
	db.db.exec(`UPDATE mailbox_agent_settings SET paused_until = ${nowSeconds() - 60}`);
	const { jobId } = insertJob(db);
	await processAgentTriageJob(env, jobId);
	assert.equal(jobOf(db, jobId).status, "completed");
	assert.equal(requests.length, 1);
});

test("the daily limit counts completed triage jobs since midnight UTC, not draft jobs", async (t) => {
	const { db, env } = await setup(t);
	db.db.exec("UPDATE mailbox_agent_settings SET auto_read_daily_limit = 1 WHERE mailbox_id = 'mailbox-a'");
	insertJob(db, { kind: "draft", status: "completed" });
	const yesterday = insertJob(db, { status: "completed" });
	db.db
		.prepare("UPDATE agent_jobs SET created_at = ?, completed_at = ? WHERE id = ?")
		.run(nowSeconds() - 2 * 86_400, nowSeconds() - 2 * 86_400, yesterday.jobId);
	const first = insertJob(db);
	const second = insertJob(db);
	const other = insertJob(db, { mailboxId: "mailbox-b" });
	await processAgentTriageJob(env, first.jobId);
	await processAgentTriageJob(env, second.jobId);
	await processAgentTriageJob(env, other.jobId);
	assert.equal(jobOf(db, first.jobId).status, "completed");
	assert.deepEqual([jobOf(db, second.jobId).status, jobOf(db, second.jobId).reason], ["skipped", "daily_limit"]);
	assert.equal(jobOf(db, other.jobId).status, "completed", "the limit is per mailbox");
	assert.equal(requests.length, 2);
	assert.deepEqual(usageOfJob(db, second.jobId), []);
});

const completedAtOf = (db, id) =>
	db.db.prepare("SELECT completed_at FROM agent_jobs WHERE id = ?").get(id).completed_at;

test("the daily limit counts by completion time: across midnight and for a recovered backlog", async (t) => {
	const dayStart = Math.floor(Date.now() / 86_400_000) * 86_400;
	for (const createdAt of [dayStart - 60, dayStart - 3 * 86_400]) {
		const { db, env } = await setup(t);
		db.db.exec("UPDATE mailbox_agent_settings SET auto_read_daily_limit = 1 WHERE mailbox_id = 'mailbox-a'");
		const carried = insertJob(db);
		db.db.prepare("UPDATE agent_jobs SET created_at = ? WHERE id = ?").run(createdAt, carried.jobId);
		const before = nowSeconds();
		await processAgentTriageJob(env, carried.jobId);
		assert.equal(jobOf(db, carried.jobId).status, "completed");
		assert.ok(completedAtOf(db, carried.jobId) >= before, "completion time is recorded");
		const next = insertJob(db);
		await processAgentTriageJob(env, next.jobId);
		assert.deepEqual([jobOf(db, next.jobId).status, jobOf(db, next.jobId).reason], ["skipped", "daily_limit"]);
	}
	const { db, env } = await setup(t);
	db.db.exec("UPDATE mailbox_agent_settings SET auto_read_daily_limit = 1 WHERE mailbox_id = 'mailbox-a'");
	const lateYesterday = insertJob(db, { status: "completed" });
	db.db
		.prepare("UPDATE agent_jobs SET created_at = ?, completed_at = ? WHERE id = ?")
		.run(dayStart - 120, dayStart - 1, lateYesterday.jobId);
	const today = insertJob(db);
	await processAgentTriageJob(env, today.jobId);
	assert.equal(jobOf(db, today.jobId).status, "completed", "a job completed before midnight counts for that day");
});

test("spoofing checks use the mailbox owner's contacts when a delegated reviewer triages", async (t) => {
	const { db, env } = await setup(t);
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('reviewer', 'reviewer@example.com', 'hash', 'Reviewer', 1);
		UPDATE mailboxes SET type = 'shared' WHERE id = 'mailbox-a';
		INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES ('access-1', 'mailbox-a', 'reviewer', 'read_only', 1);
		INSERT INTO contacts (id, user_id, email, display_name, source, created_at) VALUES ('c-owner', 'owner', 'grace@corp.test', 'Grace Hopper', 'manual', 1);
		INSERT INTO contacts (id, user_id, email, display_name, source, created_at) VALUES ('c-reviewer', 'reviewer', 'alan@corp.test', 'Alan Turing', 'manual', 1);
	`);
	const spoof = insertJob(db, { reviewer: "reviewer", from: "Grace Hopper <grace@evil.test>" });
	await processAgentTriageJob(env, spoof.jobId);
	assert.equal(jobOf(db, spoof.jobId).status, "completed");
	const [phishing] = suggestionsOf(db, spoof.messageId).filter((row) => row.kind === "phishing");
	assert.deepEqual(phishing?.payload.reasons, ["display_name_spoof"]);

	const reviewerOnly = insertJob(db, { reviewer: "reviewer", from: "Alan Turing <alan@evil.test>" });
	await processAgentTriageJob(env, reviewerOnly.jobId);
	assert.deepEqual(
		suggestionsOf(db, reviewerOnly.messageId).filter((row) => row.kind === "phishing"),
		[],
		"the reviewer's own contacts are not the mailbox's",
	);
});

test("a spoofed contact beyond the first thousand contacts is still found", async (t) => {
	const { db, env } = await setup(t);
	const insert = db.db.prepare(
		"INSERT INTO contacts (id, user_id, email, display_name, source, created_at) VALUES (?, 'owner', ?, ?, 'outbound', 1)",
	);
	db.db.transaction(() => {
		for (let index = 0; index < 1_500; index++)
			insert.run(`c-${String(index).padStart(5, "0")}`, `person${index}@corp.test`, `Person ${index}`);
		insert.run("c-zzzzz", "al@corp.test", "Al");
	})();
	const spoof = insertJob(db, { from: '"AL" <al@evil.test>' });
	await processAgentTriageJob(env, spoof.jobId);
	const [phishing] = suggestionsOf(db, spoof.messageId).filter((row) => row.kind === "phishing");
	assert.deepEqual(phishing?.payload.reasons, ["display_name_spoof"]);

	const known = insertJob(db, { from: "Person 1499 <person1499@corp.test>" });
	await processAgentTriageJob(env, known.jobId);
	assert.deepEqual(suggestionsOf(db, known.messageId), []);
	const lastRequest = requests.at(-1).body.messages[1].content;
	assert.match(lastRequest, /Known contact: yes/, "the sender's own contact row is found beyond the window too");
});

test("an emoji summary of 280 characters is stored intact", async (t) => {
	const { db, env } = await setup(t);
	const summary = `${"😀".repeat(279)}✅`;
	replies = [reply(JSON.stringify({ ...benign, summary: `${summary}${"🙂".repeat(20)}` }))];
	const { jobId, messageId } = insertJob(db, { text: `Long ${"y".repeat(1_600)}` });
	await processAgentTriageJob(env, jobId);
	assert.equal(jobOf(db, jobId).status, "completed");
	const [stored] = suggestionsOf(db, messageId).filter((row) => row.kind === "summary");
	assert.equal(stored?.payload.text, summary);
});

test("the per-mailbox rate limit skips with rate_limited before any request", async (t) => {
	const { db, env } = await setup(t);
	const keys = [];
	env.AGENT_RATE_LIMIT = {
		limit: async ({ key }) => {
			keys.push(key);
			return { success: false };
		},
	};
	const { jobId } = insertJob(db);
	await processAgentTriageJob(env, jobId);
	assert.deepEqual([jobOf(db, jobId).status, jobOf(db, jobId).reason], ["skipped", "rate_limited"]);
	assert.deepEqual(keys, ["auto-read:mailbox-a"]);
	assert.equal(requests.length, 0);
	assert.deepEqual(usageOfJob(db, jobId), []);
});

test("a mailbox spend cap below one estimate skips with spend_cap and reserves nothing", async (t) => {
	const { db, env } = await setup(t);
	db.db.exec("UPDATE mailbox_agent_settings SET daily_spend_cap_micros = 1 WHERE mailbox_id = 'mailbox-a'");
	const capped = insertJob(db);
	const other = insertJob(db, { mailboxId: "mailbox-b" });
	await processAgentTriageJob(env, capped.jobId);
	await processAgentTriageJob(env, other.jobId);
	assert.deepEqual([jobOf(db, capped.jobId).status, jobOf(db, capped.jobId).reason], ["skipped", "spend_cap"]);
	assert.deepEqual(usageOfJob(db, capped.jobId), []);
	assert.equal(jobOf(db, other.jobId).status, "completed", "the mailbox cap only applies to its mailbox");
	assert.deepEqual(usageOfJob(db, other.jobId), [{ mailbox_id: "mailbox-b", source: "auto_triage", reserved: 0 }]);
	assert.equal(requests.length, 1);
});

test("the install spend cap counts spend from every mailbox and source", async (t) => {
	const { db, env } = await setup(t);
	db.db
		.prepare(
			"INSERT INTO ai_usage (id, created_at, provider, model, source, input_tokens, output_tokens, cost_usd_micros, mailbox_id, reserved) VALUES ('chat-1', ?, 'compatible', 'fake-triage', 'chat', 1000, 100, 150, 'mailbox-a', 0)",
		)
		.run(nowSeconds());
	db.db.exec("UPDATE app_settings SET agent_daily_spend_cap_micros = 200");
	const capped = insertJob(db, { mailboxId: "mailbox-b" });
	await processAgentTriageJob(env, capped.jobId);
	assert.deepEqual([jobOf(db, capped.jobId).status, jobOf(db, capped.jobId).reason], ["skipped", "spend_cap"]);
	assert.equal(requests.length, 0);

	db.db.exec("UPDATE app_settings SET agent_daily_spend_cap_micros = 2000000");
	const raised = insertJob(db, { mailboxId: "mailbox-b" });
	await processAgentTriageJob(env, raised.jobId);
	assert.equal(jobOf(db, raised.jobId).status, "completed");
	assert.equal(requests.length, 1);
});
