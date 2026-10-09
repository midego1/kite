import assert from "node:assert/strict";
import { createServer } from "node:http";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { receiver } from "./support/alert-receiver.mjs";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-alerts-webhook-settings-");
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
			export { exportDatabaseRecords, restoreDatabaseRecords } from "./src/lib/backups/export.ts";
			export { loadAlertWebhook, saveAlertWebhook, checkAlertWebhookTarget } from "./src/lib/alerts/webhook-settings.ts";
			export { sendAlertWebhook } from "./src/lib/alerts/webhook-send.ts";
			export { buildTestAlertMessage } from "./src/lib/alerts/webhook-utils.ts";
			export { GET, PUT, DELETE } from "./src/app/api/admin/alerts/webhook/route.ts";
			export { POST as TEST } from "./src/app/api/admin/alerts/webhook/test/route.ts";
		`,
		resolveDir: root,
		sourcefile: "alerts-webhook-settings-entry.ts",
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
const {
	SqliteDatabase,
	applyMigrations,
	createSession,
	exportDatabaseRecords,
	restoreDatabaseRecords,
	loadAlertWebhook,
	saveAlertWebhook,
	checkAlertWebhookTarget,
	sendAlertWebhook,
	buildTestAlertMessage,
	GET,
	PUT,
	DELETE,
	TEST,
} = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);

const ORIGIN = "https://kite.test";
const SLACK = "https://hooks.slack.com/services/EXAMPLE/EXAMPLE/EXAMPLE";
const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
const handlers = { GET, PUT, DELETE, TEST };

async function closedPort() {
	const server = createServer();
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	await new Promise((resolve) => server.close(resolve));
	return port;
}

async function fixture(t, extraEnv = {}) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES
			('owner', 'owner@one.test', 'hash', 'Owner', 'admin', 1, 1),
			('helper', 'helper@one.test', 'hash', 'Helper', 'admin', 0, 2),
			('member', 'member@one.test', 'hash', 'Member', 'user', 0, 3);
	`);
	const env = { DB: database, KITE_RUNTIME: "node", ALERT_WEBHOOK_ALLOW_INSECURE: "1", ...extraEnv };
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
	const call = async (method, { as = "owner", origin = ORIGIN, body, raw } = {}) => {
		const handler = handlers[method];
		const path = method === "TEST" ? "/api/admin/alerts/webhook/test" : "/api/admin/alerts/webhook";
		const headers = { "Content-Type": "application/json" };
		globalThis.__alertsTestCookie = as ? { name: "ep_session", value: sessions[as] } : undefined;
		if (origin) headers.Origin = origin;
		const init = { method: method === "TEST" ? "POST" : method, headers };
		if (raw !== undefined) init.body = raw;
		else if (body !== undefined && method !== "GET") init.body = JSON.stringify(body);
		const response = await handler(new Request(`${ORIGIN}${path}`, init));
		const text = await response.text();
		return { status: response.status, text, json: text ? JSON.parse(text) : null, headers: response.headers };
	};
	const row = () =>
		database.db
			.prepare("SELECT alert_webhook_url AS url, alert_webhook_kind AS kind FROM app_settings WHERE id = 'default'")
			.get();
	return { env, database, call, row };
}

const EMPTY = { configured: false, maskedUrl: null, kind: "auto", effectiveKind: null };

test("anonymous callers get 401 and non-primary users 403 on every webhook route", async (t) => {
	const { call, row } = await fixture(t);
	for (const method of ["GET", "PUT", "DELETE", "TEST"]) {
		const anonymous = await call(method, { as: null, body: { url: SLACK } });
		assert.equal(anonymous.status, 401, method);
		assert.match(anonymous.headers.get("Cache-Control") ?? "", /no-store/, method);
		for (const as of ["helper", "member"]) {
			const denied = await call(method, { as, body: { url: SLACK } });
			assert.equal(denied.status, 403, `${method} as ${as}`);
			assert.match(denied.headers.get("Cache-Control") ?? "", /no-store/, `${method} as ${as}`);
			assert.doesNotMatch(denied.text, /slack|…/);
		}
	}
	assert.equal(row()?.url ?? null, null);
});

test("GET with nothing saved reports an unconfigured webhook and is not cached", async (t) => {
	const { call } = await fixture(t);
	const response = await call("GET");
	assert.equal(response.status, 200);
	assert.deepEqual(response.json, EMPTY);
	assert.match(response.headers.get("Cache-Control"), /no-store/);
});

test("saving returns only the mask and later reads never contain the URL", async (t) => {
	const { call } = await fixture(t);
	const url = "http://127.0.0.1:3290/hook/VALTOKEN123?k=VALQUERY";
	const saved = await call("PUT", { body: { url } });
	assert.equal(saved.status, 200);
	assert.deepEqual(saved.json, {
		configured: true,
		maskedUrl: "127.0.0.1:3290/…",
		kind: "auto",
		effectiveKind: "json",
	});
	assert.match(saved.headers.get("Cache-Control"), /no-store/);
	const read = await call("GET");
	assert.deepEqual(read.json, saved.json);
	for (const response of [saved, read]) assert.doesNotMatch(response.text, /VALTOKEN123|VALQUERY/);
});

test("a kind-only update keeps the URL and the effective kind follows the override", async (t) => {
	const { call } = await fixture(t);
	const slack = await call("PUT", { body: { url: SLACK } });
	assert.deepEqual(slack.json, {
		configured: true,
		maskedUrl: "hooks.slack.com/…",
		kind: "auto",
		effectiveKind: "slack",
	});
	const ntfy = await call("PUT", { body: { kind: "ntfy" } });
	assert.deepEqual(ntfy.json, {
		configured: true,
		maskedUrl: "hooks.slack.com/…",
		kind: "ntfy",
		effectiveKind: "ntfy",
	});
	const auto = await call("PUT", { body: { kind: "auto" } });
	assert.equal(auto.json.effectiveKind, "slack");
	assert.equal(auto.json.kind, "auto");
});

test("invalid URLs answer 400 with a code and leave the saved setting alone", async (t) => {
	const { call, row } = await fixture(t);
	await call("PUT", { body: { url: SLACK, kind: "slack" } });
	const before = row();
	const cases = [
		["not a url", "invalid_url"],
		["", "invalid_url"],
		["http://example.com/x", "https_required"],
		["https://user:pw@example.com/x", "credentials_not_allowed"],
		["https://10.0.0.1/x", "blocked_host"],
		["https://169.254.169.254/latest", "blocked_host"],
	];
	for (const [url, code] of cases) {
		const response = await call("PUT", { body: { url } });
		assert.equal(response.status, 400, url);
		assert.equal(response.json.code, code, url);
		assert.equal(typeof response.json.error, "string");
	}
	assert.deepEqual(row(), before);
	assert.equal((await call("GET")).json.maskedUrl, "hooks.slack.com/…");
});

test("malformed bodies answer 400 and change nothing", async (t) => {
	const { call, row } = await fixture(t);
	const empty = await call("PUT", { body: { kind: "json" } });
	assert.equal(empty.status, 400, "kind without a saved URL");
	assert.equal(row()?.url ?? null, null);
	await call("PUT", { body: { url: SLACK } });
	const before = row();
	for (const request of [{ body: { kind: "teams" } }, { body: {} }, { raw: "not json" }, { raw: "" }]) {
		const response = await call("PUT", request);
		assert.equal(response.status, 400, JSON.stringify(request));
		assert.equal(typeof response.json.error, "string");
	}
	assert.deepEqual(row(), before);
});

test("mutations from another origin are refused", async (t) => {
	const { call, row } = await fixture(t);
	const hook = await receiver(t);
	await call("PUT", { body: { url: `${hook.base}/hook` } });
	const before = row();
	for (const method of ["PUT", "DELETE", "TEST"]) {
		const response = await call(method, { origin: "https://evil.example", body: { url: SLACK } });
		assert.equal(response.status, 403, method);
		assert.deepEqual(response.json, { error: "Invalid origin" });
	}
	assert.deepEqual(row(), before);
	assert.equal(hook.requests.length, 0);
});

test("DELETE clears both columns", async (t) => {
	const { call, row } = await fixture(t);
	await call("PUT", { body: { url: SLACK, kind: "slack" } });
	assert.equal(row().kind, "slack");
	const removed = await call("DELETE");
	assert.equal(removed.status, 200);
	assert.deepEqual(removed.json, EMPTY);
	assert.deepEqual({ ...row() }, { url: null, kind: null });
	assert.deepEqual((await call("GET")).json, EMPTY);
});

test("the URL is sealed at rest when APP_ENCRYPTION_KEY is set", async (t) => {
	const { env, call, row } = await fixture(t, { APP_ENCRYPTION_KEY: ENCRYPTION_KEY });
	const url = "https://alerts.example.com/hook/VALTOKEN123";
	await saveAlertWebhook(env, { url });
	const stored = row().url;
	assert.ok(stored.startsWith("enc:v1:"));
	assert.doesNotMatch(stored, /alerts\.example\.com|VALTOKEN123|hook/);
	assert.deepEqual(await loadAlertWebhook(env), { url, kind: "auto" });

	await call("PUT", { body: { url: SLACK } });
	assert.ok(row().url.startsWith("enc:v1:"));
	assert.equal((await call("GET")).json.maskedUrl, "hooks.slack.com/…");
});

test("a sealed URL without its key is configured but unreadable", async (t) => {
	const { env, call } = await fixture(t, { APP_ENCRYPTION_KEY: ENCRYPTION_KEY });
	await call("PUT", { body: { url: SLACK } });
	delete env.APP_ENCRYPTION_KEY;
	assert.deepEqual((await call("GET")).json, { configured: true, maskedUrl: null, kind: "auto", effectiveKind: null });
	const tested = await call("TEST");
	assert.equal(tested.status, 502);
	assert.deepEqual(tested.json, { ok: false, reason: "unreadable" });
});

test("loopback http is refused without the insecure flag", async (t) => {
	const { call, row } = await fixture(t, { ALERT_WEBHOOK_ALLOW_INSECURE: undefined });
	const response = await call("PUT", { body: { url: "http://127.0.0.1:3290/hook" } });
	assert.equal(response.status, 400);
	assert.ok(["blocked_host", "https_required"].includes(response.json.code));
	assert.equal(row()?.url ?? null, null);
});

test("the test endpoint needs a saved webhook", async (t) => {
	const { call } = await fixture(t);
	const response = await call("TEST");
	assert.equal(response.status, 400);
	assert.deepEqual(response.json, { error: "No alert webhook configured" });
});

test("a test send posts one JSON message and reports the status", async (t) => {
	const { call } = await fixture(t);
	const hook = await receiver(t);
	await call("PUT", { body: { url: `${hook.base}/hook` } });
	const response = await call("TEST");
	assert.equal(response.status, 200);
	assert.deepEqual(response.json, { ok: true, status: 200 });
	assert.equal(hook.requests.length, 1);
	const [request] = hook.requests;
	assert.equal(request.method, "POST");
	assert.equal(request.headers["content-type"], "application/json");
	const body = JSON.parse(request.body);
	assert.deepEqual(Object.keys(body).sort(), ["alerts", "app", "sentAt", "test", "url"]);
	assert.equal(body.test, true);
	assert.deepEqual(body.alerts, [{ rule: "test", name: "Test alert", count: 1 }]);
});

test("a failing receiver gets one attempt and its body is never echoed", async (t) => {
	const { call } = await fixture(t);
	const hook = await receiver(t);
	await call("PUT", { body: { url: `${hook.base}/hook` } });
	hook.setMode({ status: 500, body: "RECEIVER_SECRET_BODY" });
	const response = await call("TEST");
	assert.equal(response.status, 502);
	assert.deepEqual(response.json, { ok: false, reason: "http_status", status: 500 });
	assert.doesNotMatch(response.text, /RECEIVER_SECRET_BODY/);
	assert.equal(hook.requests.length, 1);
});

test("redirects are reported as failures and not followed", async (t) => {
	const { call } = await fixture(t);
	const hook = await receiver(t);
	const target = await receiver(t);
	await call("PUT", { body: { url: `${hook.base}/hook` } });
	hook.setMode({ status: 302, location: `${target.base}/redirected` });
	const response = await call("TEST");
	assert.deepEqual(response.json, { ok: false, reason: "http_status", status: 302 });
	assert.equal(response.status, 502);
	assert.equal(target.requests.length, 0);
});

test("an unreachable receiver is a network failure", async (t) => {
	const { call } = await fixture(t);
	await call("PUT", { body: { url: `http://127.0.0.1:${await closedPort()}/none` } });
	const response = await call("TEST");
	assert.equal(response.status, 502);
	assert.deepEqual(response.json, { ok: false, reason: "network" });
});

test("sendAlertWebhook times out a silent receiver and retries once when asked", async (t) => {
	const { env, call } = await fixture(t);
	const hook = await receiver(t);
	await call("PUT", { body: { url: `${hook.base}/hook` } });
	const message = buildTestAlertMessage({ appName: "Kite", sentAt: new Date(0) });
	hook.setMode({ hang: true });
	const failures = [];
	const timedOut = await sendAlertWebhook(env, message, {
		retry: false,
		timeoutMs: 100,
		onAttemptFailed: (failure) => failures.push(failure),
	});
	assert.deepEqual(timedOut, { channel: "webhook", outcome: "failed", reason: "timeout" });

	hook.requests.length = 0;
	hook.setMode({ status: 503 });
	const retried = await sendAlertWebhook(env, message, {
		retry: true,
		delayMs: 1,
		onAttemptFailed: (failure) => failures.push(failure),
	});
	assert.deepEqual(retried, { channel: "webhook", outcome: "failed", reason: "http_status", status: 503 });
	assert.equal(hook.requests.length, 2);
	assert.deepEqual(
		failures.slice(-2).map(({ attempt, reason, status }) => ({ attempt, reason, status })),
		[
			{ attempt: 1, reason: "http_status", status: 503 },
			{ attempt: 2, reason: "http_status", status: 503 },
		],
	);
	hook.setMode({ status: 204 });
	assert.deepEqual(await sendAlertWebhook(env, message, { retry: true }), {
		channel: "webhook",
		outcome: "sent",
		status: 204,
	});
});

test("a name that resolves to a private address is refused on save and on send", async (t) => {
	const { env, call, database } = await fixture(t, { RESOLVE_HOST: async () => ["10.0.0.5"] });
	await assert.rejects(checkAlertWebhookTarget(env, "https://hooks.example.com/x"), { code: "blocked_host" });
	const saved = await call("PUT", { body: { url: "https://hooks.example.com/x" } });
	assert.equal(saved.status, 400);
	assert.equal(saved.json.code, "blocked_host");

	database.db.exec(`
		INSERT INTO app_settings (id, alert_webhook_url, updated_at) VALUES ('default', 'https://hooks.example.com/x', 1)
			ON CONFLICT (id) DO UPDATE SET alert_webhook_url = excluded.alert_webhook_url;
	`);
	const originalFetch = globalThis.fetch;
	let fetched = 0;
	globalThis.fetch = async () => {
		fetched++;
		return new Response(null, { status: 200 });
	};
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	const message = buildTestAlertMessage({ appName: "Kite", sentAt: new Date(0) });
	assert.deepEqual(await sendAlertWebhook(env, message, { retry: true }), {
		channel: "webhook",
		outcome: "failed",
		reason: "blocked_url",
	});
	assert.equal(fetched, 0);
});

test("the target is rechecked before the retry, so a name that turns private after a failure is not fetched again", async (t) => {
	let addresses = ["93.184.216.34"];
	const { env, database } = await fixture(t, { RESOLVE_HOST: async () => addresses });
	database.db.exec(`
		INSERT INTO app_settings (id, alert_webhook_url, updated_at) VALUES ('default', 'https://alerts.example.com/hook', 1)
			ON CONFLICT (id) DO UPDATE SET alert_webhook_url = excluded.alert_webhook_url;
	`);
	const originalFetch = globalThis.fetch;
	let fetched = 0;
	globalThis.fetch = async () => {
		fetched++;
		addresses = ["10.0.0.5"];
		return new Response(null, { status: 503 });
	};
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	const failures = [];
	const message = buildTestAlertMessage({ appName: "Kite", sentAt: new Date(0) });
	const result = await sendAlertWebhook(env, message, {
		retry: true,
		delayMs: 1,
		onAttemptFailed: ({ attempt, reason, status }) => failures.push({ attempt, reason, status }),
	});
	assert.deepEqual(result, { channel: "webhook", outcome: "failed", reason: "blocked_url" });
	assert.equal(fetched, 1);
	assert.deepEqual(failures, [
		{ attempt: 1, reason: "http_status", status: 503 },
		{ attempt: 2, reason: "blocked_url", status: undefined },
	]);
});

test("a backup document without the alert webhook columns restores with both NULL", async (t) => {
	const { env, database, row } = await fixture(t);
	await saveAlertWebhook(env, { url: SLACK, kind: "slack" });
	const document = JSON.parse(new TextDecoder().decode(await exportDatabaseRecords(database)));
	assert.equal(document.tables.app_settings[0].alert_webhook_kind, "slack");
	for (const settings of document.tables.app_settings) {
		delete settings.alert_webhook_url;
		delete settings.alert_webhook_kind;
	}
	await restoreDatabaseRecords(database, new TextEncoder().encode(JSON.stringify(document)).buffer);
	assert.deepEqual({ ...row() }, { url: null, kind: null });
	assert.equal(database.db.prepare("SELECT count(*) AS count FROM users").get().count, 3);
});
