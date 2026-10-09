import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { receiver } from "./support/alert-receiver.mjs";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-alerts-run-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createNodeRuntime } from "./server/runtime/env.ts";
			export { runOperationalAlerts } from "./src/lib/alerts/run.ts";
		`,
		resolveDir: root,
		sourcefile: "alerts-run-entry.ts",
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
	alias: { "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});
const { SqliteDatabase, applyMigrations, createNodeRuntime, runOperationalAlerts } = await import(
	pathToFileURL(join(bundleDirectory, "entry.mjs")).href
);

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const sec = (ms) => Math.floor(ms / 1000);

async function fixture(t, { sending = true, extraEnv = {} } = {}) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, reset_email, password_hash, name, role, is_primary_admin, created_at)
			VALUES ('admin', 'owner@one.test', NULL, 'hash', 'Owner', 'admin', 1, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, sending_provider, sending_enabled, created_at)
			VALUES ('one', 'admin', 'one.test', 'zone', 'active', '${sending ? "cloudflare" : "none"}', 1, 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb', 'admin', 'one', 'owner', 1);
	`);
	const store = new Map();
	const sent = [];
	const env = {
		DB: database,
		BUCKET: {
			get: async (key) => (store.has(key) ? { text: async () => store.get(key) } : null),
			put: async (key, value) => void store.set(key, value),
		},
		EMAIL: {
			send: async (message) => {
				sent.push(message);
				return { messageId: "<id@one.test>" };
			},
		},
		...extraEnv,
	};
	const failJobs = (count, at) => {
		for (let i = 0; i < count; i++) {
			database.db
				.prepare(
					"INSERT INTO outbound_jobs (id, user_id, status, payload, created_at, updated_at) VALUES (?, 'admin', 'failed', 'VALSECRET', ?, ?)",
				)
				.run(`job-${at}-${i}`, sec(at), sec(at));
		}
	};
	const state = () => JSON.parse(store.get("system/alert-state.json"));
	return { database, env, sent, store, failJobs, state };
}

test("runs 1 to 4 send 0, 1, 0 and 1 emails", async (t) => {
	const { env, sent, failJobs, state, database } = await fixture(t);
	await runOperationalAlerts(env, new Date(T0));
	assert.equal(sent.length, 0);
	assert.deepEqual(state().rules, {});
	assert.equal(state().initializedAt, T0);

	failJobs(6, T0 + 5 * MIN);
	database.db
		.prepare(
			"INSERT INTO backups (id, status, trigger, error, created_at, completed_at) VALUES ('val_bk1', 'failed', 'scheduled', 'VALSECRET carol@evil.test', ?, ?)",
		)
		.run(sec(T0 + 5 * MIN), sec(T0 + 5 * MIN));
	await runOperationalAlerts(env, new Date(T0 + 10 * MIN));
	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0].to, ["owner@one.test"]);
	assert.match(sent[0].subject, /^Kite: 2 operational alerts$/);
	assert.doesNotMatch(sent[0].text, /@|VALSECRET|val_bk1|job-/);
	assert.equal(state().lastEmailAt, T0 + 10 * MIN);

	await runOperationalAlerts(env, new Date(T0 + 15 * MIN));
	assert.equal(sent.length, 1);

	// Failed jobs age out of the 60 minute window; a stuck job keeps the reminder alive.
	database.db
		.prepare(
			"INSERT INTO outbound_jobs (id, user_id, status, payload, created_at, updated_at) VALUES ('stuck', 'admin', 'queued', 'VALSECRET', ?, ?)",
		)
		.run(sec(T0), sec(T0));
	await runOperationalAlerts(env, new Date(T0 + 70 * MIN));
	assert.equal(sent.length, 2);
	assert.match(sent[1].text, /stuck in the queue: 1/);
	await runOperationalAlerts(env, new Date(T0 + 26 * HOUR));
	assert.equal(sent.length, 3);
	assert.doesNotMatch(sent[2].text, /Failed backups/);
});

test("a stuck sending job older than 15 minutes alerts and a future scheduled job does not", async (t) => {
	const { env, sent, database } = await fixture(t);
	await runOperationalAlerts(env, new Date(T0));
	const insert = database.db.prepare(
		"INSERT INTO outbound_jobs (id, user_id, status, payload, scheduled_at, created_at, updated_at) VALUES (?, 'admin', ?, 'p', ?, ?, ?)",
	);
	insert.run("future", "queued", sec(T0 + 10 * HOUR), sec(T0 - 2 * HOUR), sec(T0 - 2 * HOUR));
	await runOperationalAlerts(env, new Date(T0 + 5 * MIN));
	assert.equal(sent.length, 0);
	insert.run("sending", "sending", null, sec(T0), sec(T0));
	await runOperationalAlerts(env, new Date(T0 + 20 * MIN));
	assert.equal(sent.length, 1);
});

test("an exhausted webhook alerts", async (t) => {
	const { env, sent, database } = await fixture(t);
	await runOperationalAlerts(env, new Date(T0));
	database.db.exec(`
		INSERT INTO webhooks (id, user_id, url, events, secret, created_at) VALUES ('wh', 'admin', 'https://hook.test', '[]', 's', 1);
		INSERT INTO webhook_deliveries (id, webhook_id, event_type, payload, status, last_attempt_at, created_at)
			VALUES ('d1', 'wh', 'message.received', '{}', 'exhausted', ${sec(T0 + 2 * MIN)}, ${sec(T0 + 2 * MIN)});
	`);
	await runOperationalAlerts(env, new Date(T0 + 5 * MIN));
	assert.equal(sent.length, 1);
	assert.match(sent[0].text, /ran out of retries: 1/);
});

test("reset_email wins over email", async (t) => {
	const { env, sent, failJobs, database } = await fixture(t);
	database.db.exec("UPDATE users SET reset_email = 'ops@elsewhere.test'");
	await runOperationalAlerts(env, new Date(T0));
	failJobs(5, T0 + MIN);
	await runOperationalAlerts(env, new Date(T0 + 5 * MIN));
	assert.deepEqual(sent[0].to, ["ops@elsewhere.test"]);
});

test("OPERATIONAL_ALERTS=off writes no state and sends nothing", async (t) => {
	const off = await fixture(t, { extraEnv: { OPERATIONAL_ALERTS: "off", ALERT_WEBHOOK_ALLOW_INSECURE: "1" } });
	const server = await receiver(t);
	saveHook(off.database, `${server.base}/hook/PATHTOKEN`);
	insertStuckJob(off.database);
	await runOperationalAlerts(off.env, new Date(T0));
	await runOperationalAlerts(off.env, new Date(T0 + 5 * MIN));
	assert.equal(off.store.size, 0);
	assert.equal(off.sent.length, 0);
	assert.equal(server.requests.length, 0);
	const on = await fixture(t);
	await runOperationalAlerts(on.env, new Date(T0));
	assert.equal(on.store.size, 1);
});

test("no sending domain logs notify_skipped and keeps the alert pending", async (t) => {
	const { env, sent, failJobs, state } = await fixture(t, { sending: false });
	await runOperationalAlerts(env, new Date(T0));
	failJobs(5, T0 + MIN);
	const lines = [];
	t.mock.method(console, "warn", (line) => lines.push(String(line)));
	await runOperationalAlerts(env, new Date(T0 + 5 * MIN));
	assert.equal(sent.length, 0);
	assert.ok(lines.some((line) => line.includes("alerts.notify_skipped") && line.includes("no_sender")));
	assert.deepEqual(state().rules, {});
	assert.equal(state().lastEmailAt, undefined);
});

test("a throwing send logs notify_failed, saves lastAttemptAt and backs off 60 minutes", async (t) => {
	const { env, sent, failJobs, state } = await fixture(t);
	await runOperationalAlerts(env, new Date(T0));
	failJobs(5, T0 + MIN);
	const lines = [];
	t.mock.method(console, "error", (line) => lines.push(String(line)));
	const original = env.EMAIL.send;
	env.EMAIL.send = async () => {
		throw new Error("provider down");
	};
	await runOperationalAlerts(env, new Date(T0 + 5 * MIN));
	assert.ok(lines.some((line) => line.includes("alerts.notify_failed")));
	assert.equal(state().lastAttemptAt, T0 + 5 * MIN);
	assert.deepEqual(state().rules, {});

	env.EMAIL.send = original;
	await runOperationalAlerts(env, new Date(T0 + 40 * MIN));
	assert.equal(sent.length, 0);
	failJobs(5, T0 + 50 * MIN);
	await runOperationalAlerts(env, new Date(T0 + 65 * MIN));
	assert.equal(sent.length, 1);
});

test("the Node runtime env forwards OPERATIONAL_ALERTS from the process environment", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "kite-node-env-"));
	const saved = { DATA_DIR: process.env.DATA_DIR, OPERATIONAL_ALERTS: process.env.OPERATIONAL_ALERTS };
	t.after(() => {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(dir, { recursive: true, force: true });
	});
	process.env.DATA_DIR = dir;
	process.env.OPERATIONAL_ALERTS = "off";
	const runtime = createNodeRuntime();
	t.after(() => runtime.database.db.close());
	assert.equal(runtime.env.OPERATIONAL_ALERTS, "off");
});

// Multi-channel delivery: the email channel above plus the alert webhook.

const FAST = { delayMs: 1, emailTimeoutMs: 200, webhookTimeoutMs: 500 };
const STATE_KEY = "system/alert-state.json";

function captureLogs(t) {
	const lines = [];
	for (const method of ["log", "warn", "error"]) t.mock.method(console, method, (line) => lines.push(String(line)));
	const events = (name) =>
		lines
			.map((line) => JSON.parse(line))
			.filter((entry) => entry.event === name)
			.map((entry) => entry.fields);
	return { lines, events };
}

function saveHook(database, url, kind = null) {
	database.db
		.prepare(
			`INSERT INTO app_settings (id, alert_webhook_url, alert_webhook_kind, updated_at) VALUES ('default', ?, ?, 1)
				ON CONFLICT (id) DO UPDATE SET alert_webhook_url = excluded.alert_webhook_url, alert_webhook_kind = excluded.alert_webhook_kind`,
		)
		.run(url, kind);
}

function insertStuckJob(database, id = "job_secret_456", at = T0 - HOUR) {
	database.db
		.prepare(
			"INSERT INTO outbound_jobs (id, user_id, status, payload, created_at, updated_at) VALUES (?, 'admin', 'queued', 'VALSECRET', ?, ?)",
		)
		.run(id, sec(at), sec(at));
}

function insertFailedBackup(database, id, at, error = "VALSECRET") {
	database.db
		.prepare(
			"INSERT INTO backups (id, status, trigger, error, created_at, completed_at) VALUES (?, 'failed', 'scheduled', ?, ?, ?)",
		)
		.run(id, error, sec(at), sec(at));
}

/** A fixture with a baseline already recorded at T0, a stuck job, and the webhook pointed at a local receiver. */
async function channelFixture(t, { sending = false, hook = true, kind = null, extraEnv = {} } = {}) {
	const base = await fixture(t, { sending, extraEnv: { ALERT_WEBHOOK_ALLOW_INSECURE: "1", ...extraEnv } });
	const server = await receiver(t);
	if (hook) saveHook(base.database, `${server.base}/hook/PATHTOKEN`, kind);
	await runOperationalAlerts(base.env, new Date(T0), FAST);
	insertStuckJob(base.database);
	return { ...base, server };
}

const failingEmail = (env) => {
	let calls = 0;
	env.EMAIL.send = async () => {
		calls++;
		throw new Error("provider down");
	};
	return () => calls;
};

test("the first run with a webhook configured only records the baseline", async (t) => {
	const { env, database, sent, state } = await fixture(t, { extraEnv: { ALERT_WEBHOOK_ALLOW_INSECURE: "1" } });
	const server = await receiver(t);
	saveHook(database, `${server.base}/hook/PATHTOKEN`);
	insertStuckJob(database);
	await runOperationalAlerts(env, new Date(T0), FAST);
	assert.equal(server.requests.length, 0);
	assert.equal(sent.length, 0);
	assert.deepEqual(state(), { version: 1, initializedAt: T0, rules: {} });
});

test("with no email sender the webhook delivers and the state advances", async (t) => {
	const { env, server, state } = await channelFixture(t);
	const logs = captureLogs(t);
	await runOperationalAlerts(env, new Date(T0 + 5 * MIN), FAST);
	assert.equal(server.requests.length, 1);
	const [request] = server.requests;
	assert.equal(request.method, "POST");
	assert.equal(request.url, "/hook/PATHTOKEN");
	const body = JSON.parse(request.body);
	assert.deepEqual(body.alerts, [{ rule: "outbound_stuck", name: "Outbound messages stuck in the queue", count: 1 }]);
	assert.equal(body.app, "Kite");
	assert.equal(body.url, null);
	assert.equal(body.sentAt, new Date(T0 + 5 * MIN).toISOString());
	assert.equal("test" in body, false);
	assert.equal(state().lastEmailAt, T0 + 5 * MIN);
	assert.equal(state().rules.outbound_stuck.notifiedAt, T0 + 5 * MIN);
	assert.deepEqual(logs.events("alerts.notified"), [{ rules: ["outbound_stuck"], count: 1, channels: ["webhook"] }]);
});

test("several due rules make one request per channel, the hourly throttle holds and a reminder follows after 24 h", async (t) => {
	const { env, database, server, sent, state } = await channelFixture(t, { sending: true });
	insertFailedBackup(database, "bk1", T0 + 2 * MIN);
	const logs = captureLogs(t);
	await runOperationalAlerts(env, new Date(T0 + 5 * MIN), FAST);
	assert.equal(server.requests.length, 1);
	assert.equal(sent.length, 1);
	assert.deepEqual(
		JSON.parse(server.requests[0].body).alerts.map((alert) => alert.rule),
		["backup_failed", "outbound_stuck"],
	);
	assert.deepEqual(logs.events("alerts.notified")[0].channels, ["email", "webhook"]);
	const delivered = state();

	insertFailedBackup(database, "bk2", T0 + 20 * MIN);
	await runOperationalAlerts(env, new Date(T0 + 25 * MIN), FAST);
	await runOperationalAlerts(env, new Date(T0 + 50 * MIN), FAST);
	assert.equal(server.requests.length, 1);
	assert.equal(sent.length, 1);
	assert.equal(state().lastEmailAt, delivered.lastEmailAt);

	// The backups age out of the window; the unchanged stuck job is repeated a day later.
	await runOperationalAlerts(env, new Date(T0 + 25 * HOUR), FAST);
	assert.equal(server.requests.length, 2);
	assert.equal(sent.length, 2);
	assert.deepEqual(
		JSON.parse(server.requests[1].body).alerts.map((alert) => alert.rule),
		["outbound_stuck"],
	);
});

test("no sender and no webhook writes no state and logs notify_skipped no_channel", async (t) => {
	const { env, store, server } = await channelFixture(t, { hook: false });
	const before = store.get(STATE_KEY);
	const logs = captureLogs(t);
	await runOperationalAlerts(env, new Date(T0 + 5 * MIN), FAST);
	assert.equal(store.get(STATE_KEY), before);
	assert.equal(server.requests.length, 0);
	const [skipped] = logs.events("alerts.notify_skipped");
	assert.equal(skipped.reason, "no_channel");
	assert.deepEqual(skipped.results, [
		{ channel: "email", outcome: "skipped", reason: "no_sender" },
		{ channel: "webhook", outcome: "skipped", reason: "not_configured" },
	]);
});

test("email throwing and the webhook failing twice record a backoff attempt and log no URL, host or recipient", async (t) => {
	const { env, server, state } = await channelFixture(t, { sending: true });
	const emailCalls = failingEmail(env);
	server.setMode({ status: 500, body: "RECEIVERBODY" });
	const before = state();
	const logs = captureLogs(t);
	await runOperationalAlerts(env, new Date(T0 + 5 * MIN), FAST);
	assert.equal(server.requests.length, 2);
	assert.equal(emailCalls(), 2);
	assert.deepEqual(state(), { ...before, lastAttemptAt: T0 + 5 * MIN });
	assert.equal(logs.events("alerts.notify_failed").length, 1);
	assert.deepEqual(
		logs
			.events("alerts.channel_failed")
			.map(({ channel, attempt, reason, status }) => ({ channel, attempt, reason, status }))
			.sort((a, b) => a.channel.localeCompare(b.channel) || a.attempt - b.attempt),
		[
			{ channel: "email", attempt: 1, reason: "send_error", status: undefined },
			{ channel: "email", attempt: 2, reason: "send_error", status: undefined },
			{ channel: "webhook", attempt: 1, reason: "http_status", status: 500 },
			{ channel: "webhook", attempt: 2, reason: "http_status", status: 500 },
		],
	);
	for (const line of logs.lines) {
		assert.doesNotMatch(line, new RegExp(`127\\.0\\.0\\.1|${server.port}|PATHTOKEN|RECEIVERBODY|owner@one\\.test`));
	}

	server.setMode({ status: 200 });
	env.EMAIL.send = async () => ({ messageId: "<id@one.test>" });
	await runOperationalAlerts(env, new Date(T0 + 40 * MIN), FAST);
	assert.equal(server.requests.length, 2);
	await runOperationalAlerts(env, new Date(T0 + 66 * MIN), FAST);
	assert.equal(server.requests.length, 3);
	assert.equal(state().lastEmailAt, T0 + 66 * MIN);
});

test("email throwing on both attempts does not stop the webhook from delivering", async (t) => {
	const { env, server, state } = await channelFixture(t, { sending: true });
	const emailCalls = failingEmail(env);
	const logs = captureLogs(t);
	await runOperationalAlerts(env, new Date(T0 + 5 * MIN), FAST);
	assert.equal(emailCalls(), 2);
	assert.equal(server.requests.length, 1);
	assert.equal(state().lastEmailAt, T0 + 5 * MIN);
	assert.deepEqual(logs.events("alerts.notified")[0].channels, ["webhook"]);
	assert.deepEqual(
		logs.events("alerts.channel_failed").map(({ channel, attempt }) => ({ channel, attempt })),
		[
			{ channel: "email", attempt: 1 },
			{ channel: "email", attempt: 2 },
		],
	);
});

test("an email send that hangs times out per attempt while the webhook delivers", async (t) => {
	const { env, server, state } = await channelFixture(t, { sending: true });
	env.EMAIL.send = () => new Promise(() => {});
	const logs = captureLogs(t);
	await runOperationalAlerts(env, new Date(T0 + 5 * MIN), FAST);
	assert.equal(server.requests.length, 1);
	assert.equal(state().lastEmailAt, T0 + 5 * MIN);
	assert.deepEqual(
		logs.events("alerts.channel_failed").map(({ channel, attempt, reason }) => ({ channel, attempt, reason })),
		[
			{ channel: "email", attempt: 1, reason: "timeout" },
			{ channel: "email", attempt: 2, reason: "timeout" },
		],
	);
});

test("email delivering while the webhook fails counts as delivered", async (t) => {
	const { env, server, sent, state } = await channelFixture(t, { sending: true });
	server.setMode({ status: 503 });
	const logs = captureLogs(t);
	await runOperationalAlerts(env, new Date(T0 + 5 * MIN), FAST);
	assert.equal(sent.length, 1);
	assert.equal(server.requests.length, 2);
	assert.equal(state().lastEmailAt, T0 + 5 * MIN);
	assert.equal(state().lastAttemptAt, undefined);
	assert.deepEqual(logs.events("alerts.notified")[0].channels, ["email"]);
});

test("a webhook that fails once and then succeeds counts as delivered", async (t) => {
	const { env, server, state } = await channelFixture(t);
	server.setModes([{ status: 500 }, { status: 200 }]);
	await runOperationalAlerts(env, new Date(T0 + 5 * MIN), FAST);
	assert.equal(server.requests.length, 2);
	assert.equal(state().lastEmailAt, T0 + 5 * MIN);
	assert.equal(state().rules.outbound_stuck.notifiedAt, T0 + 5 * MIN);
});

test("an email channel without a sender is not retried", async (t) => {
	const { env, store } = await channelFixture(t, { hook: false });
	const before = store.get(STATE_KEY);
	const started = Date.now();
	// A retry would sleep for the full delay first.
	await runOperationalAlerts(env, new Date(T0 + 5 * MIN), { ...FAST, delayMs: 5_000 });
	assert.ok(Date.now() - started < 2_000);
	assert.equal(store.get(STATE_KEY), before);
});

test("an unreadable sealed webhook URL fails the webhook channel with reason unreadable", async (t) => {
	const { env, database, state } = await channelFixture(t, { hook: false });
	saveHook(database, "enc:v1:aaaa:bbbb");
	const before = state();
	const logs = captureLogs(t);
	await runOperationalAlerts(env, new Date(T0 + 5 * MIN), FAST);
	assert.equal(logs.events("alerts.webhook_unreadable").length, 1);
	assert.deepEqual(logs.events("alerts.notify_failed")[0].results, [
		{ channel: "email", outcome: "skipped", reason: "no_sender" },
		{ channel: "webhook", outcome: "failed", reason: "unreadable" },
	]);
	assert.deepEqual(logs.events("alerts.channel_failed"), [{ channel: "webhook", attempt: 1, reason: "unreadable" }]);
	assert.deepEqual(state(), { ...before, lastAttemptAt: T0 + 5 * MIN });
});

test("the webhook target is rechecked on every send, so a name that now resolves privately is not fetched", async (t) => {
	let addresses = ["93.184.216.34"];
	const { env, database, state } = await channelFixture(t, {
		hook: false,
		extraEnv: { RESOLVE_HOST: async () => addresses },
	});
	saveHook(database, "https://alerts.example.com/hook");
	const originalFetch = globalThis.fetch;
	const fetched = [];
	globalThis.fetch = async (url) => {
		fetched.push(String(url));
		return new Response(null, { status: 200 });
	};
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	await runOperationalAlerts(env, new Date(T0 + 5 * MIN), FAST);
	assert.deepEqual(fetched, ["https://alerts.example.com/hook"]);

	addresses = ["10.0.0.5"];
	const logs = captureLogs(t);
	await runOperationalAlerts(env, new Date(T0 + 25 * HOUR), FAST);
	assert.equal(fetched.length, 1);
	assert.deepEqual(logs.events("alerts.channel_failed"), [{ channel: "webhook", attempt: 1, reason: "blocked_url" }]);
	assert.equal(state().lastAttemptAt, T0 + 25 * HOUR);
});

test("delivered payloads carry no backup id, job id, error text, address or fingerprint in any format", async (t) => {
	for (const kind of ["json", "slack", "discord", "ntfy"]) {
		const { env, database, server, state } = await channelFixture(t, {
			kind,
			extraEnv: { APP_URL: "https://kite.example.com" },
		});
		insertFailedBackup(database, "bk_secret_123", T0 + 2 * MIN, "disk quota exceeded for ops@example.com");
		await runOperationalAlerts(env, new Date(T0 + 5 * MIN), FAST);
		assert.equal(server.requests.length, 1, kind);
		const fingerprints = Object.values(state().rules).map((rule) => rule.fingerprint);
		assert.ok(fingerprints.includes("bk_secret_123"));
		const recorded = JSON.stringify({ headers: server.requests[0].headers, body: server.requests[0].body });
		for (const forbidden of ["bk_secret_123", "job_secret_456", "disk quota", "VALSECRET", "@"]) {
			assert.equal(recorded.includes(forbidden), false, `${kind} payload contains ${forbidden}`);
		}
		assert.match(server.requests[0].body, /Failed backups/);
		assert.match(server.requests[0].body, /Outbound messages stuck in the queue/);
	}
});

test("a state file in the pre-webhook shape keeps its baseline", async (t) => {
	const { env, store, server, state } = await channelFixture(t);
	const legacy = { version: 1, initializedAt: T0 - 2 * HOUR, lastEmailAt: T0 - 2 * HOUR, rules: {} };
	store.set(STATE_KEY, JSON.stringify(legacy));
	await runOperationalAlerts(env, new Date(T0 + 5 * MIN), FAST);
	assert.equal(server.requests.length, 1);
	assert.equal(state().initializedAt, T0 - 2 * HOUR);
	assert.equal(state().lastEmailAt, T0 + 5 * MIN);
});
