import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const collectorDir = join(root, "deploy/telemetry-collector");
const outDir = makeBundleDirectory("kite-telemetry-collector-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		collector: join(collectorDir, "src/index.ts"),
		validate: join(collectorDir, "src/validate.ts"),
		runtime: join(root, "server/runtime/sqlite-database.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	splitting: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	packages: "external",
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { default: collector, purgeOldDays } = await load("collector");
const { parseHeartbeat } = await load("validate");
const { SqliteDatabase } = await load("runtime");

const TOKEN = "test-only-stats-token";
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (days) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

function heartbeat(overrides = {}) {
	return {
		telemetry_schema_version: 1,
		install_id: "3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e",
		version: "2026.10.26.0",
		runtime: "workers",
		users_total: 3,
		users_active_1d: 1,
		users_active_7d: 2,
		users_active_30d: 3,
		mailboxes_total: 4,
		mailboxes_active_1d: 2,
		inbound_1d: 10,
		outbound_1d: 5,
		modules_enabled: ["calendar", "drive"],
		...overrides,
	};
}

test("the validator accepts exactly schema version 1", () => {
	assert.equal(parseHeartbeat(JSON.stringify(heartbeat())).ok, true);
	assert.equal(parseHeartbeat(JSON.stringify(heartbeat({ version: "unknown", runtime: "node" }))).ok, true);
	const refused = (body) => {
		const result = parseHeartbeat(typeof body === "string" ? body : JSON.stringify(body));
		assert.equal(result.ok, false, JSON.stringify(body).slice(0, 80));
		return result.error;
	};
	assert.equal(refused("{"), "invalid_json");
	assert.equal(refused([heartbeat()]), "not_an_object");
	assert.equal(refused(null), "not_an_object");
	assert.equal(refused({ ...heartbeat(), hostname: "mail.example.com" }), "unknown_key");
	assert.equal(refused({ ...heartbeat(), email: "owner@example.com" }), "unknown_key");
	const { inbound_1d: _omitted, ...missing } = heartbeat();
	assert.equal(refused(missing), "missing_inbound_1d");
	assert.equal(refused(heartbeat({ telemetry_schema_version: 2 })), "unsupported_schema_version");
	assert.equal(refused(heartbeat({ install_id: "owner@example.com" })), "invalid_install_id");
	assert.equal(refused(heartbeat({ version: "1.0 mail.example.com" })), "invalid_version");
	assert.equal(refused(heartbeat({ runtime: "lambda" })), "invalid_runtime");
	for (const value of [-1, 1.5, "3", null, 2 ** 31, Number.MAX_SAFE_INTEGER])
		assert.equal(refused(heartbeat({ users_total: value })), "invalid_users_total", String(value));
	for (const value of [
		"calendar",
		["Calendar"],
		["drive", "drive"],
		[1],
		Array.from({ length: 33 }, (_, i) => `m${i}`),
	])
		assert.equal(refused(heartbeat({ modules_enabled: value })), "invalid_modules_enabled", JSON.stringify(value));
	assert.equal(refused(JSON.stringify(heartbeat()).padEnd(2049, " ")), "too_large");
});

async function setup(t) {
	const sqlite = new SqliteDatabase(":memory:");
	t.after(() => sqlite.db.close());
	sqlite.db.exec(readFileSync(join(collectorDir, "migrations/0001_init.sql"), "utf8"));
	return { sqlite, env: { DB: sqlite, STATS_TOKEN: TOKEN } };
}

function post(body, headers = {}) {
	const text = typeof body === "string" ? body : JSON.stringify(body);
	return new Request("https://collector.example.test/v1/heartbeat", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Content-Length": String(Buffer.byteLength(text)),
			"CF-Connecting-IP": "203.0.113.9",
			"User-Agent": "kite-test-agent",
			...headers,
		},
		body: text,
	});
}

const stats = (env, token = TOKEN) =>
	collector.fetch(
		new Request("https://collector.example.test/v1/stats", {
			headers: token === null ? {} : { Authorization: `Bearer ${token}` },
		}),
		env,
	);

test("heartbeats are stored once per install and day, without anything about the request", async (t) => {
	const { sqlite, env } = await setup(t);
	assert.equal((await collector.fetch(post(heartbeat()), env)).status, 204);
	assert.equal((await collector.fetch(post(heartbeat({ users_total: 4, version: "2026.10.27.0" })), env)).status, 204);
	const daily = sqlite.db.prepare("SELECT * FROM daily").all();
	assert.equal(daily.length, 1);
	assert.equal(daily[0].day, today());
	assert.equal(daily[0].users_total, 4, "the latest report of the day wins");
	assert.equal(daily[0].modules_enabled, '["calendar","drive"]');
	assert.deepEqual(sqlite.db.prepare("SELECT * FROM installs").all(), [
		{
			install_id: heartbeat().install_id,
			first_seen: today(),
			last_seen: today(),
			last_version: "2026.10.27.0",
			last_runtime: "workers",
		},
	]);
	const dump = Buffer.from(await sqlite.dump()).toString("latin1");
	assert.ok(!dump.includes("203.0.113.9"));
	assert.ok(!dump.includes("kite-test-agent"));
});

test("bad requests are refused before anything is written", async (t) => {
	const { sqlite, env } = await setup(t);
	const status = async (request) => (await collector.fetch(request, env)).status;
	assert.equal(await status(post({ ...heartbeat(), extra: 1 })), 400);
	assert.equal(await status(post(heartbeat(), { "Content-Type": "text/plain" })), 415);
	assert.equal(await status(post(heartbeat(), { "Content-Length": "4096" })), 413);
	assert.equal(await status(new Request("https://collector.example.test/v1/heartbeat")), 405);
	assert.equal(await status(new Request("https://collector.example.test/")), 404);
	const answer = await collector.fetch(post({ ...heartbeat(), email: "owner@example.com" }), env);
	assert.deepEqual(await answer.json(), { error: "unknown_key" });
	assert.equal(sqlite.db.prepare("SELECT COUNT(*) AS n FROM daily").get().n, 0);
});

test("stats need the bearer token and count distinct installs", async (t) => {
	const { sqlite, env } = await setup(t);
	assert.equal((await stats(env, null)).status, 401);
	assert.equal((await stats(env, "wrong")).status, 401);
	assert.equal((await stats({ DB: sqlite }, TOKEN)).status, 401, "closed without STATS_TOKEN");
	assert.equal(
		(await collector.fetch(new Request("https://collector.example.test/v1/stats", { method: "POST" }), env)).status,
		405,
	);

	const insertInstall = sqlite.db.prepare("INSERT INTO installs VALUES (?, ?, ?, ?, ?)");
	const insertDay = sqlite.db.prepare("INSERT INTO daily VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
	const ids = ["a", "b", "c", "d"].map((letter) => `${letter.repeat(8)}-aaaa-4aaa-8aaa-${letter.repeat(12)}`);
	// a: today; b: 5 days ago; c: 20 days ago; d: 100 days ago.
	[0, 5, 20, 100].forEach((days, index) => {
		const runtime = index === 1 ? "node" : "workers";
		insertInstall.run(ids[index], daysAgo(days + 10), daysAgo(days), "2026.10.26.0", runtime);
		insertDay.run(daysAgo(days), ids[index], "2026.10.26.0", runtime, 2, 1, 1, 2, 3, 1, 7, 4, '["calendar"]');
	});
	insertDay.run(daysAgo(1), ids[0], "2026.10.25.0", "workers", 9, 9, 9, 9, 9, 9, 9, 9, '["drive"]');

	const response = await stats(env);
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("Cache-Control"), "no-store");
	const body = await response.json();
	assert.deepEqual(body.installs, { total: 4, active_1d: 1, active_7d: 2, active_30d: 3 });
	assert.deepEqual(body.usage, {
		installs: 1,
		users_total: 2,
		users_active_1d: 1,
		users_active_7d: 1,
		users_active_30d: 2,
		mailboxes_total: 3,
		mailboxes_active_1d: 1,
		inbound_1d: 7,
		outbound_1d: 4,
	});
	assert.deepEqual(body.versions, [{ version: "2026.10.26.0", installs: 3 }]);
	assert.deepEqual(body.runtimes, [
		{ runtime: "workers", installs: 2 },
		{ runtime: "node", installs: 1 },
	]);
	assert.deepEqual(body.modules, [{ module: "calendar", installs: 3 }], "from each install's latest report");

	await purgeOldDays({ DB: sqlite, DAILY_RETENTION_DAYS: "60" }, Date.now());
	assert.equal(sqlite.db.prepare("SELECT COUNT(*) AS n FROM daily WHERE install_id = ?").get(ids[3]).n, 0);
	assert.equal(sqlite.db.prepare("SELECT COUNT(*) AS n FROM installs").get().n, 4, "installs are kept");
});
