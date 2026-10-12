import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-agent-auto-read-schedule-");
after(() => rmSync(outDir, { recursive: true, force: true }));

const common = {
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
};
// import.meta.resolve (rather than a joined path) lets knip see which modules this test uses.
// Only the pure modules get source maps: the database-backed bundles pull in much of the app
// without running it, and mapped zero-hit copies would stand in for those files in the coverage gate.
await build({
	...common,
	sourcemap: "inline",
	entryPoints: {
		scheduleUtils: fileURLToPath(import.meta.resolve("../src/lib/agent/auto-read/schedule-utils.ts")),
		queueUtils: fileURLToPath(import.meta.resolve("../src/lib/agent/queue-utils.ts")),
	},
});
await build({
	...common,
	entryPoints: {
		schedule: fileURLToPath(import.meta.resolve("../src/lib/agent/auto-read/schedule.ts")),
		installSettings: fileURLToPath(import.meta.resolve("../src/lib/agent/auto-read/install-settings.ts")),
		recovery: fileURLToPath(import.meta.resolve("../src/lib/agent/jobs/recovery.ts")),
		queue: fileURLToPath(import.meta.resolve("../src/lib/agent/queue.ts")),
		runtime: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
	},
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { scheduleAgentWork } = await load("schedule");
const { RECOVERY_WINDOW_MS, isAutoSubmitted, isPaused, triageMessageGate, withinRecoveryWindow } =
	await load("scheduleUtils");
const { skipPendingMailboxJobs } = await load("installSettings");
const { recoverAgentJobs } = await load("recovery");
const { processAgentQueueMessage } = await load("queue");
const { agentJobKindOf, agentJobQueueMessage, dispatchAgentJob } = await load("queueUtils");
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");

const nowSeconds = () => Math.floor(Date.now() / 1000);

async function setup(t, { autonomy = "suggest", autoDraft = false } = {}) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, join(root, "drizzle/migrations"));
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Owner', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES
			('mailbox-a', 'owner', 'domain-1', 'a', 1),
			('mailbox-b', 'owner', 'domain-1', 'b', 1);
		INSERT OR IGNORE INTO app_settings (id, updated_at) VALUES ('default', 1);
		UPDATE app_settings SET agent_enabled = 1, agent_auto_read_enabled = 1;
	`);
	db.db
		.prepare(
			"INSERT INTO mailbox_agent_settings (mailbox_id, enabled, auto_draft_enabled, autonomy, updated_at) VALUES ('mailbox-a', 1, ?, ?, 1), ('mailbox-b', 1, 0, 'suggest', 1)",
		)
		.run(autoDraft ? 1 : 0, autonomy);
	const sent = [];
	const env = { DB: db, AGENT_QUEUE: { send: async (message) => void sent.push(message) } };
	return { db, env, sent };
}

let messageCount = 0;
function insertMessage(db, { mailboxId = "mailbox-a", createdAt = nowSeconds(), providerMessageId = null } = {}) {
	const id = `message-${++messageCount}`;
	db.db
		.prepare(
			"INSERT INTO messages (id, user_id, mailbox_id, direction, provider_message_id, from_addr, to_addr, subject, text_body, status, thread_id, created_at) VALUES (?, 'owner', ?, 'inbound', ?, 'customer@example.net', 'a@example.com', 'Question', 'Hello', 'received', ?, ?)",
		)
		.run(id, mailboxId, providerMessageId ?? `<${id}@example.net>`, `thread-${id}`, createdAt);
	return id;
}

function workInput(sourceMessageId, overrides = {}) {
	return {
		mailboxId: "mailbox-a",
		sourceMessageId,
		ownerUserId: "owner",
		sender: "Customer <customer@example.net>",
		headers: {},
		status: "received",
		folderId: null,
		spamVerdict: "inbox",
		spamAnalysisError: null,
		...overrides,
	};
}

const jobs = (db) =>
	db.db.prepare("SELECT kind, status, source_message_id, mailbox_id FROM agent_jobs ORDER BY kind, id").all();

test("the recovery path schedules a recent message once and an old message never", async (t) => {
	const { db, env, sent } = await setup(t);
	const old = insertMessage(db, { createdAt: nowSeconds() - 31 * 60 });
	await scheduleAgentWork(env, workInput(old, { recoveryReceivedAt: new Date(Date.now() - 31 * 60_000) }));
	assert.deepEqual(jobs(db), []);
	assert.deepEqual(sent, []);

	const recent = insertMessage(db);
	await scheduleAgentWork(env, workInput(recent, { recoveryReceivedAt: new Date(Date.now() - 60_000) }));
	const created = jobs(db);
	assert.deepEqual(created, [
		{ kind: "triage", status: "pending", source_message_id: recent, mailbox_id: "mailbox-a" },
	]);
	const [{ id }] = db.db.prepare("SELECT id FROM agent_jobs").all();
	assert.deepEqual(sent, [{ kind: "agent.triage", jobId: id }]);
});

test("delivering the same message twice leaves one triage job, also for a copy under a new raw key", async (t) => {
	const { db, env } = await setup(t);
	const first = insertMessage(db, { providerMessageId: "<same@example.net>" });
	await scheduleAgentWork(env, workInput(first));
	await scheduleAgentWork(env, workInput(first, { recoveryReceivedAt: new Date() }));
	const copy = insertMessage(db, { providerMessageId: "<same@example.net>" });
	await scheduleAgentWork(env, workInput(copy));
	assert.equal(jobs(db).length, 1);
	assert.equal(jobs(db)[0].source_message_id, first);
});

test("two stored copies of one Message-ID scheduled at the same time leave one triage job", async (t) => {
	const { db, env, sent } = await setup(t);
	const first = insertMessage(db, { providerMessageId: "<race@example.net>" });
	const second = insertMessage(db, { providerMessageId: "<race@example.net>" });
	const other = insertMessage(db, { mailboxId: "mailbox-b", providerMessageId: "<race@example.net>" });
	await Promise.all([
		scheduleAgentWork(env, workInput(first)),
		scheduleAgentWork(env, workInput(second)),
		scheduleAgentWork(env, workInput(other, { mailboxId: "mailbox-b" })),
	]);
	const created = jobs(db);
	assert.equal(created.filter((job) => job.mailbox_id === "mailbox-a").length, 1);
	assert.equal(created.filter((job) => job.mailbox_id === "mailbox-b").length, 1, "dedupe is per mailbox");
	assert.equal(sent.length, 2);

	const untagged = [insertMessage(db), insertMessage(db)];
	db.db.prepare("UPDATE messages SET provider_message_id = NULL WHERE id IN (?, ?)").run(...untagged);
	await Promise.all(untagged.map((id) => scheduleAgentWork(env, workInput(id))));
	assert.equal(jobs(db).length, 4, "copies without a Message-ID are not merged");
});

test("ineligible mail gets no triage job", async (t) => {
	const { db, env, sent } = await setup(t);
	const cases = [
		{ status: "spam" },
		{ status: "trash" },
		{ sender: "A Mailbox <A@example.com>" },
		{ sender: "MAILER-DAEMON@relay.example.net" },
		{ sender: "postmaster@relay.example.net" },
		{ headers: { "Auto-Submitted": "auto-replied" } },
	];
	for (const overrides of cases) await scheduleAgentWork(env, workInput(insertMessage(db), overrides));
	assert.deepEqual(jobs(db), []);
	assert.deepEqual(sent, []);

	await scheduleAgentWork(env, workInput(insertMessage(db), { headers: { "auto-submitted": "no" } }));
	await scheduleAgentWork(
		env,
		workInput(insertMessage(db), { headers: { "List-Id": "<team.example.net>", Precedence: "bulk" } }),
	);
	await scheduleAgentWork(env, workInput(insertMessage(db), { sender: "no-reply@vendor.example" }));
	assert.deepEqual(
		jobs(db).map((job) => job.kind),
		["triage", "triage", "triage"],
	);
});

test("a disabled reviewer, a paused mailbox or the install switches stop scheduling", async (t) => {
	const { db, env } = await setup(t);
	db.db.exec("UPDATE users SET disabled = 1");
	await scheduleAgentWork(env, workInput(insertMessage(db)));
	db.db.exec("UPDATE users SET disabled = 0");
	db.db.prepare("UPDATE mailbox_agent_settings SET paused_until = ?").run(nowSeconds() + 3600);
	await scheduleAgentWork(env, workInput(insertMessage(db)));
	db.db.exec("UPDATE mailbox_agent_settings SET paused_until = NULL");
	db.db.exec("UPDATE app_settings SET agent_auto_read_enabled = 0");
	await scheduleAgentWork(env, workInput(insertMessage(db)));
	db.db.exec("UPDATE app_settings SET agent_auto_read_enabled = 1, agent_enabled = 0");
	await scheduleAgentWork(env, workInput(insertMessage(db)));
	assert.deepEqual(jobs(db), []);
});

test("a reviewer with read access to a shared mailbox is enough for triage", async (t) => {
	const { db, env } = await setup(t);
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('reader', 'reader@example.com', 'hash', 'Reader', 1);
		UPDATE mailboxes SET type = 'shared' WHERE id = 'mailbox-a';
		INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES ('access-1', 'mailbox-a', 'reader', 'read_only', 1);
		UPDATE mailbox_agent_settings SET reviewer_user_id = 'reader' WHERE mailbox_id = 'mailbox-a';
	`);
	await scheduleAgentWork(env, workInput(insertMessage(db)));
	assert.equal(jobs(db).length, 1);
	db.db.exec("DELETE FROM mailbox_access");
	await scheduleAgentWork(env, workInput(insertMessage(db)));
	assert.equal(jobs(db).length, 1);
});

test("autonomy off keeps the legacy auto-draft job and nothing else", async (t) => {
	const { db, env, sent } = await setup(t, { autonomy: "off", autoDraft: true });
	const id = insertMessage(db);
	await scheduleAgentWork(env, workInput(id));
	assert.deepEqual(
		jobs(db).map((job) => job.kind),
		["draft"],
	);
	assert.equal(sent[0].kind, "agent.draft");
	db.db.exec("UPDATE mailbox_agent_settings SET auto_draft_enabled = 0");
	await scheduleAgentWork(env, workInput(insertMessage(db)));
	assert.equal(jobs(db).length, 1);
});

test("an existing draft job does not block the triage job for the same message", async (t) => {
	const { db, env } = await setup(t);
	const id = insertMessage(db);
	db.db
		.prepare(
			"INSERT INTO agent_jobs (id, mailbox_id, source_message_id, reviewer_user_id, kind, status, next_attempt_at, created_at) VALUES ('draft-job', 'mailbox-a', ?, 'owner', 'draft', 'completed', 1, 1)",
		)
		.run(id);
	await scheduleAgentWork(env, workInput(id));
	assert.deepEqual(
		jobs(db).map((job) => [job.kind, job.status]),
		[
			["draft", "completed"],
			["triage", "pending"],
		],
	);
});

function insertJob(
	db,
	{ id, mailboxId = "mailbox-a", kind, status = "pending", nextAttemptAt = 1, leaseUntil = null },
) {
	db.db
		.prepare(
			"INSERT INTO agent_jobs (id, mailbox_id, source_message_id, reviewer_user_id, kind, status, next_attempt_at, lease_until, created_at) VALUES (?, ?, ?, 'owner', ?, ?, ?, ?, 1)",
		)
		.run(id, mailboxId, insertMessage(db, { mailboxId }), kind, status, nextAttemptAt, leaseUntil);
}

const statusOf = (db, id) => db.db.prepare("SELECT status, reason FROM agent_jobs WHERE id = ?").get(id);

test("skipping pending jobs touches only the given mailbox and kind", async (t) => {
	const { db, env } = await setup(t);
	insertJob(db, { id: "a-triage", kind: "triage" });
	insertJob(db, { id: "a-draft", kind: "draft" });
	insertJob(db, { id: "b-triage", mailboxId: "mailbox-b", kind: "triage" });
	await skipPendingMailboxJobs(env, "mailbox-a", "triage", "autonomy_off");
	assert.deepEqual(statusOf(db, "a-triage"), { status: "skipped", reason: "autonomy_off" });
	assert.equal(statusOf(db, "a-draft").status, "pending");
	assert.equal(statusOf(db, "b-triage").status, "pending");
	await skipPendingMailboxJobs(env, "mailbox-a", "draft", "Auto-drafting disabled");
	assert.equal(statusOf(db, "a-draft").status, "skipped");
	assert.equal(statusOf(db, "b-triage").status, "pending");
});

test("recovery re-runs due and lease-expired jobs under their own kind", async (t) => {
	const { db, env } = await setup(t);
	const expired = nowSeconds() - 60;
	insertJob(db, { id: "triage-due", kind: "triage" });
	insertJob(db, { id: "triage-stuck", mailboxId: "mailbox-b", kind: "triage", status: "running", leaseUntil: expired });
	insertJob(db, { id: "draft-due", kind: "draft" });
	insertJob(db, { id: "triage-later", kind: "triage", nextAttemptAt: nowSeconds() + 3600 });
	insertJob(db, { id: "triage-leased", kind: "triage", status: "running", leaseUntil: nowSeconds() + 600 });
	const dispatched = [];
	await recoverAgentJobs(env, async (message) => void dispatched.push(message));
	assert.deepEqual(
		dispatched.sort((a, b) => a.jobId.localeCompare(b.jobId)),
		[
			{ kind: "agent.draft", jobId: "draft-due" },
			{ kind: "agent.triage", jobId: "triage-due" },
			{ kind: "agent.triage", jobId: "triage-stuck" },
		],
	);
});

test("an agent.triage message is processed as a triage job and completes", async (t) => {
	const { db, env } = await setup(t);
	// No capability needs the model, so the job settles from facts alone without a provider.
	db.db.exec(
		`UPDATE mailbox_agent_settings SET capabilities = '{"calendar":false,"reply":false,"summary":false,"phishing":false}'`,
	);
	insertJob(db, { id: "triage-1", kind: "triage" });
	assert.equal(await processAgentQueueMessage(env, { kind: "agent.triage", jobId: "triage-1" }), true);
	assert.deepEqual(statusOf(db, "triage-1"), { status: "completed", reason: null });

	insertJob(db, { id: "triage-2", kind: "triage" });
	db.db.exec("UPDATE mailbox_agent_settings SET autonomy = 'off' WHERE mailbox_id = 'mailbox-a'");
	await processAgentQueueMessage(env, { kind: "agent.triage", jobId: "triage-2" });
	assert.deepEqual(statusOf(db, "triage-2"), { status: "skipped", reason: "autonomy_off" });

	assert.equal(await processAgentQueueMessage(env, { kind: "import.imap", jobId: "import-1" }), false);
});

function openReplyOn(db, messageId, threadId) {
	db.db
		.prepare("UPDATE messages SET thread_id = ?, created_at = ? WHERE id = ?")
		.run(threadId, nowSeconds() - 60, messageId);
	db.db
		.prepare(
			"INSERT INTO agent_suggestions (id, mailbox_id, message_id, thread_id, reviewer_user_id, kind, status, title, payload, created_at) VALUES (?, 'mailbox-a', ?, ?, 'owner', 'reply', 'open', 'Reply', '{}', ?)",
		)
		.run(`sugg-${messageId}`, messageId, threadId, nowSeconds() - 60);
	return `sugg-${messageId}`;
}

function newerInThread(db, threadId) {
	const id = insertMessage(db);
	db.db.prepare("UPDATE messages SET thread_id = ? WHERE id = ?").run(threadId, id);
	return id;
}

const suggestionStatus = (db, id) => db.db.prepare("SELECT status FROM agent_suggestions WHERE id = ?").get(id).status;

test("a newer message in the thread supersedes the older open reply even when its own triage is skipped", async (t) => {
	const { db, env } = await setup(t);
	const realFetch = globalThis.fetch;
	let modelRequests = 0;
	globalThis.fetch = async () => {
		modelRequests += 1;
		throw new Error("no model request expected");
	};
	t.after(() => {
		globalThis.fetch = realFetch;
	});

	db.db.exec("UPDATE mailbox_agent_settings SET auto_read_daily_limit = 0 WHERE mailbox_id = 'mailbox-a'");
	const limited = openReplyOn(db, insertMessage(db), "thread-limit");
	const newer = newerInThread(db, "thread-limit");
	await scheduleAgentWork(env, workInput(newer));
	assert.equal(suggestionStatus(db, limited), "superseded");
	const [{ id: jobId }] = db.db.prepare("SELECT id FROM agent_jobs WHERE source_message_id = ?").all(newer);
	await processAgentQueueMessage(env, { kind: "agent.triage", jobId });
	assert.deepEqual(statusOf(db, jobId), { status: "skipped", reason: "daily_limit" });

	db.db.prepare("UPDATE mailbox_agent_settings SET paused_until = ?").run(nowSeconds() + 3600);
	const paused = openReplyOn(db, insertMessage(db), "thread-paused");
	await scheduleAgentWork(env, workInput(newerInThread(db, "thread-paused")));
	assert.equal(suggestionStatus(db, paused), "superseded");
	assert.equal(jobs(db).length, 1, "a paused mailbox schedules no job");

	const other = openReplyOn(db, insertMessage(db), "thread-other");
	await scheduleAgentWork(env, workInput(insertMessage(db)));
	assert.equal(suggestionStatus(db, other), "open", "mail in another thread leaves it open");
	assert.equal(modelRequests, 0);
});

test("the queue helpers map kinds both ways and route each body to its handler", async () => {
	assert.deepEqual(agentJobQueueMessage("triage", "j1"), { kind: "agent.triage", jobId: "j1" });
	assert.deepEqual(agentJobQueueMessage("draft", "j1"), { kind: "agent.draft", jobId: "j1" });
	assert.equal(agentJobKindOf({ kind: "agent.triage", jobId: "j1" }), "triage");
	assert.equal(agentJobKindOf({ kind: "agent.draft", jobId: "j1" }), "draft");
	for (const body of [null, "x", {}, { kind: "agent.triage" }, { kind: "import.imap", jobId: "j1" }])
		assert.equal(agentJobKindOf(body), null);
	const calls = [];
	const handlers = {
		draft: async (jobId) => void calls.push(["draft", jobId]),
		triage: async (jobId) => void calls.push(["triage", jobId]),
	};
	assert.equal(await dispatchAgentJob({ kind: "agent.triage", jobId: "t1" }, handlers), true);
	assert.equal(await dispatchAgentJob({ kind: "agent.draft", jobId: "d1" }, handlers), true);
	assert.equal(await dispatchAgentJob({ kind: "import.imap", jobId: "i1" }, handlers), false);
	assert.deepEqual(calls, [
		["triage", "t1"],
		["draft", "d1"],
	]);
});

test("both runtimes hand agent queue bodies to the shared dispatcher before IMAP imports", () => {
	const node = readFileSync(join(root, "server/index.ts"), "utf8");
	assert.match(
		node,
		/agentQueue\.setConsumer\(async \(body\) => \{\s*if \(await processAgentQueueMessage\(env, body\)\) return;\s*if \(isImportJobQueueMessage\(body\)\)/,
	);
	const worker = readFileSync(join(root, "worker.ts"), "utf8");
	assert.match(worker, /else if \(await processAgentQueueMessage\(env, msg\.body\)\)/);
	const dispatcher = readFileSync(join(root, "src/lib/agent/queue.ts"), "utf8");
	assert.match(dispatcher, /triage: \(jobId\) => processAgentTriageJob\(env, jobId\)/);
});

test("schedule gates are pure and case-insensitive", () => {
	const now = Date.now();
	assert.equal(withinRecoveryWindow(undefined, now), true);
	assert.equal(withinRecoveryWindow(new Date(now - RECOVERY_WINDOW_MS + 1), now), true);
	assert.equal(withinRecoveryWindow(new Date(now - RECOVERY_WINDOW_MS), now), false);
	assert.equal(isAutoSubmitted(undefined), false);
	assert.equal(isAutoSubmitted({ "AUTO-SUBMITTED": " No " }), false);
	assert.equal(isAutoSubmitted({ "Auto-Submitted": "auto-generated" }), true);
	assert.equal(isPaused(null, now), false);
	assert.equal(isPaused(new Date(now + 1), now), true);
	assert.equal(isPaused(new Date(now - 1), now), false);
	const base = { status: "received", sender: "x@example.net", ownAddresses: ["a@example.com"] };
	assert.equal(triageMessageGate(base), null);
	assert.equal(triageMessageGate({ ...base, status: "archived" }), "not_in_inbox");
	assert.equal(triageMessageGate({ ...base, sender: "" }), "no_sender");
	assert.equal(triageMessageGate({ ...base, sender: "A <A@Example.com>" }), "own_address");
	assert.equal(triageMessageGate({ ...base, sender: "Postmaster@relay.example.net" }), "bounce_sender");
	assert.equal(triageMessageGate({ ...base, headers: { "Auto-Submitted": "auto-replied" } }), "auto_submitted");
});
