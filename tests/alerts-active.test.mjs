import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { receiver } from "./support/alert-receiver.mjs";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-alerts-active-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
// Session routes read the cookie through next/headers, which needs a Next request scope; the shim serves the test's cookie.
const cookieShim = join(bundleDirectory, "next-headers-shim.mjs");
writeFileSync(
	cookieShim,
	`export async function cookies() {
		return { get: (name) => (globalThis.__alertsTestCookie?.name === name ? globalThis.__alertsTestCookie : undefined) };
	}`,
);
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createSession } from "./src/lib/auth/session.ts";
			export { GET } from "./src/app/api/admin/alerts/active/route.ts";
		`,
		resolveDir: root,
		sourcefile: "alerts-active-entry.ts",
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
		"next/headers": cookieShim,
		"next/server": "next/server.js",
		"cloudflare:workers": "./server/runtime/cloudflare-workers.ts",
	},
	logLevel: "silent",
});
const { SqliteDatabase, applyMigrations, createSession, GET } = await import(
	pathToFileURL(join(bundleDirectory, "entry.mjs")).href
);

const MIN = 60_000;
const STATE_KEY = "system/alert-state.json";
const sec = (ms) => Math.floor(ms / 1000);

async function fixture(t, extraEnv = {}) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES
			('owner', 'owner@one.test', 'hash', 'Owner', 'admin', 1, 1),
			('helper', 'helper@one.test', 'hash', 'Helper', 'admin', 0, 2),
			('member', 'member@one.test', 'hash', 'Member', 'user', 0, 3);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, sending_provider, sending_enabled, created_at)
			VALUES ('one', 'owner', 'one.test', 'zone', 'active', 'cloudflare', 1, 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb', 'owner', 'one', 'owner', 1);
	`);
	const store = new Map();
	const writes = [];
	const sent = [];
	const env = {
		DB: database,
		KITE_RUNTIME: "node",
		ALERT_WEBHOOK_ALLOW_INSECURE: "1",
		BUCKET: {
			get: async (key) => (store.has(key) ? { text: async () => store.get(key) } : null),
			put: async (key, value) => {
				writes.push(key);
				store.set(key, value);
			},
		},
		EMAIL: {
			send: async (message) => {
				sent.push(message);
				return { messageId: "<id@one.test>" };
			},
		},
		...extraEnv,
	};
	globalThis.__kiteNodeEnv = env;
	t.after(() => {
		delete globalThis.__kiteNodeEnv;
		delete globalThis.__alertsTestCookie;
	});
	const sessions = {
		owner: await createSession(env, "owner"),
		helper: await createSession(env, "helper"),
		member: await createSession(env, "member"),
	};
	const call = async (as = "owner") => {
		globalThis.__alertsTestCookie = as ? { name: "ep_session", value: sessions[as] } : undefined;
		const response = await GET(new Request("https://kite.test/api/admin/alerts/active"));
		const text = await response.text();
		return { status: response.status, json: text ? JSON.parse(text) : null, headers: response.headers };
	};
	const insertStuckJob = (id, at = Date.now() - 60 * MIN) =>
		database.db
			.prepare(
				"INSERT INTO outbound_jobs (id, user_id, status, payload, created_at, updated_at) VALUES (?, 'owner', 'queued', 'VALSECRET', ?, ?)",
			)
			.run(id, sec(at), sec(at));
	const insertFailedBackup = (id, at) =>
		database.db
			.prepare(
				"INSERT INTO backups (id, status, trigger, error, created_at, completed_at) VALUES (?, 'failed', 'scheduled', 'VALSECRET', ?, ?)",
			)
			.run(id, sec(at), sec(at));
	const saveHook = (url) =>
		database.db
			.prepare(
				`INSERT INTO app_settings (id, alert_webhook_url, updated_at) VALUES ('default', ?, 1)
					ON CONFLICT (id) DO UPDATE SET alert_webhook_url = excluded.alert_webhook_url`,
			)
			.run(url);
	return { env, store, writes, sent, call, insertStuckJob, insertFailedBackup, saveHook };
}

const STUCK = { rule: "outbound_stuck", name: "Outbound messages stuck in the queue", count: 1, href: "/admin" };

test("anonymous callers get 401, regular users 403 and every admin 200, all uncached", async (t) => {
	const { call } = await fixture(t);
	const anonymous = await call(null);
	assert.equal(anonymous.status, 401);
	assert.match(anonymous.headers.get("cache-control") ?? "", /no-store/);
	const member = await call("member");
	assert.equal(member.status, 403);
	assert.match(member.headers.get("cache-control") ?? "", /no-store/);
	for (const as of ["owner", "helper"]) {
		const response = await call(as);
		assert.equal(response.status, 200, as);
		assert.match(response.headers.get("cache-control") ?? "", /no-store/);
		assert.deepEqual(response.json, { enabled: true, alerts: [], signature: null });
	}
});

test("lists active alerts in rule order with name, count and href", async (t) => {
	const { call, insertStuckJob, insertFailedBackup } = await fixture(t);
	insertStuckJob("job_secret_1");
	const stuckOnly = await call();
	assert.deepEqual(stuckOnly.json.alerts, [STUCK]);
	assert.equal(typeof stuckOnly.json.signature, "string");
	assert.equal((await call()).json.signature, stuckOnly.json.signature);

	insertFailedBackup("bk_secret_1", Date.now());
	const both = await call("helper");
	assert.equal(both.status, 200);
	assert.deepEqual(both.json, {
		enabled: true,
		alerts: [{ rule: "backup_failed", name: "Failed backups", count: 1, href: "/backups" }, STUCK],
		signature: both.json.signature,
	});
	for (const alert of both.json.alerts) assert.deepEqual(Object.keys(alert), ["rule", "name", "count", "href"]);
	assert.notEqual(both.json.signature, stuckOnly.json.signature);
	assert.doesNotMatch(JSON.stringify(both.json.alerts), /secret/i);
	assert.doesNotMatch(JSON.stringify(both.json), /VALSECRET|job_secret/);
});

test("the signature ignores count changes", async (t) => {
	const { call, insertStuckJob } = await fixture(t);
	insertStuckJob("job_1");
	const first = await call();
	insertStuckJob("job_2");
	const second = await call();
	assert.equal(second.json.alerts[0].count, 2);
	assert.equal(second.json.signature, first.json.signature);
});

test("without a baseline the counting rules look back 60 minutes", async (t) => {
	const { call, insertFailedBackup } = await fixture(t);
	insertFailedBackup("recent", Date.now() - 30 * MIN);
	insertFailedBackup("old", Date.now() - 120 * MIN);
	const response = await call();
	assert.deepEqual(response.json.alerts, [
		{ rule: "backup_failed", name: "Failed backups", count: 1, href: "/backups" },
	]);
});

test("with a baseline, events before initializedAt are excluded but stuck jobs still count", async (t) => {
	const { call, store, insertFailedBackup, insertStuckJob } = await fixture(t);
	insertFailedBackup("before", Date.now() - 30 * MIN);
	insertStuckJob("job_before", Date.now() - 120 * MIN);
	store.set(STATE_KEY, JSON.stringify({ version: 1, initializedAt: Date.now() - 10 * MIN, rules: {} }));
	const response = await call();
	assert.deepEqual(response.json.alerts, [STUCK]);
});

test("is read-only: no baseline, no state change, no email and no webhook request", async (t) => {
	const { call, store, writes, sent, saveHook, insertStuckJob, insertFailedBackup } = await fixture(t);
	const server = await receiver(t);
	saveHook(`${server.base}/hook/PATHTOKEN`);
	insertStuckJob("job_1");
	insertFailedBackup("bk_1", Date.now());
	const lines = [];
	for (const method of ["log", "warn", "error"]) t.mock.method(console, method, (line) => lines.push(String(line)));
	for (let i = 0; i < 5; i++) assert.equal((await call()).json.alerts.length, 2);
	assert.equal(store.has(STATE_KEY), false);

	const saved = JSON.stringify({
		version: 1,
		initializedAt: 1,
		rules: { outbound_stuck: { fingerprint: "x", notifiedAt: 1 } },
	});
	store.set(STATE_KEY, saved);
	for (let i = 0; i < 5; i++) assert.equal((await call()).status, 200);
	assert.equal(store.get(STATE_KEY), saved);
	assert.deepEqual(writes, []);
	assert.equal(sent.length, 0);
	assert.equal(server.requests.length, 0);
	assert.equal(lines.filter((line) => /alerts\.(notified|notify_failed|channel_failed)/.test(line)).length, 0);
});

test("OPERATIONAL_ALERTS=off answers disabled with no alerts", async (t) => {
	const { call, store, insertStuckJob, insertFailedBackup } = await fixture(t, { OPERATIONAL_ALERTS: "off" });
	insertStuckJob("job_1");
	insertFailedBackup("bk_1", Date.now());
	const response = await call();
	assert.equal(response.status, 200);
	assert.match(response.headers.get("cache-control") ?? "", /no-store/);
	assert.deepEqual(response.json, { enabled: false, alerts: [], signature: null });
	assert.equal(store.size, 0);
	assert.equal((await call(null)).status, 401);
});
