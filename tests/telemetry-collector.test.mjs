import assert from "node:assert/strict";
import { readdirSync, readFileSync, rmSync } from "node:fs";
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
		worker: join(collectorDir, "src/index.ts"),
		collector: join(collectorDir, "src/collector.ts"),
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
const worker = await load("worker");
const { default: collector } = worker;
const { rollUpOldDays, RAW_RETENTION_DAYS, MIN_PUBLIC_INSTALLS, SMALL_CELL } = await load("collector");
const { parseHeartbeat } = await load("validate");

test("the Worker entrypoint exports only its default handler", () => {
	// workerd treats every named export of the main module as an entrypoint and refuses the Worker (error 1101)
	// when one is not a handler, such as a constant.
	assert.deepEqual(Object.keys(worker), ["default"]);
	assert.equal(typeof collector.fetch, "function");
	assert.equal(typeof collector.scheduled, "function");
	const source = readFileSync(join(collectorDir, "src/index.ts"), "utf8");
	assert.deepEqual(
		source.match(/^export\b.*$/gm).map((line) => line.split(/\s+/).slice(0, 2).join(" ")),
		["export default"],
	);
});
const { SqliteDatabase } = await load("runtime");

const TOKEN = "test-only-stats-token";
const INSTALL_ID = "3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e";
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (days) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
const idFor = (letter) => `${letter.repeat(8)}-aaaa-4aaa-8aaa-${letter.repeat(12)}`;

function heartbeat(overrides = {}) {
	return {
		telemetry_schema_version: 2,
		install_id: INSTALL_ID,
		version: "2026.10.26.0",
		runtime: "workers",
		users_total: "2-5",
		users_active_1d: "1",
		users_active_7d: "2-5",
		users_active_30d: "2-5",
		mailboxes_total: "2-5",
		mailboxes_active_1d: "2-5",
		inbound_1d: "1-10",
		outbound_1d: "1-10",
		modules_enabled: ["calendar", "drive"],
		...overrides,
	};
}

test("the validator accepts exactly schema version 2, with every count a range", () => {
	assert.equal(parseHeartbeat(JSON.stringify(heartbeat())).ok, true);
	assert.equal(parseHeartbeat(JSON.stringify(heartbeat({ version: "unknown", runtime: "node" }))).ok, true);
	for (const value of ["0", "1", "2-5", "6-20", "21-100", "100+"])
		assert.equal(parseHeartbeat(JSON.stringify(heartbeat({ users_total: value }))).ok, true, value);
	for (const value of ["0", "1-10", "11-100", "101-1000", "1000+"])
		assert.equal(parseHeartbeat(JSON.stringify(heartbeat({ inbound_1d: value }))).ok, true, value);
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
	// Version 1 carried exact counts; it is refused, not stored.
	const v1 = { ...heartbeat({ telemetry_schema_version: 1 }), users_total: 3, inbound_1d: 10 };
	assert.equal(refused(v1), "unsupported_schema_version");
	assert.equal(refused(heartbeat({ telemetry_schema_version: 3 })), "unsupported_schema_version");
	assert.equal(refused(heartbeat({ install_id: "owner@example.com" })), "invalid_install_id");
	assert.equal(refused(heartbeat({ version: "1.0 mail.example.com" })), "invalid_version");
	assert.equal(refused(heartbeat({ runtime: "lambda" })), "invalid_runtime");
	for (const value of [3, "3", "1-10", "1000+", "", null, "2-5 "])
		assert.equal(refused(heartbeat({ users_total: value })), "invalid_users_total", String(value));
	for (const value of [10, "10", "2-5", "100+", "1001+"])
		assert.equal(refused(heartbeat({ outbound_1d: value })), "invalid_outbound_1d", String(value));
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

async function setup(t, overrides = {}) {
	const sqlite = new SqliteDatabase(":memory:");
	t.after(() => sqlite.db.close());
	const migrations = join(collectorDir, "migrations");
	for (const file of readdirSync(migrations).sort()) sqlite.db.exec(readFileSync(join(migrations, file), "utf8"));
	return { sqlite, env: { DB: sqlite, STATS_TOKEN: TOKEN, ...overrides } };
}

function post(body, headers = {}) {
	const text = typeof body === "string" ? body : JSON.stringify(body);
	return new Request("https://collector.example.test/v1/heartbeat", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Content-Length": String(Buffer.byteLength(text)),
			"CF-Connecting-IP": "203.0.113.9",
			"CF-Worker": "mail.example.com",
			"User-Agent": "kite-test-agent",
			...headers,
		},
		body: text,
	});
}

const erase = (env, id, method = "DELETE", ip = "203.0.113.9") =>
	collector.fetch(
		new Request(`https://collector.example.test/v1/installs/${id}`, {
			method,
			headers: { "CF-Connecting-IP": ip, "CF-Worker": "mail.example.com" },
		}),
		env,
	);

const get = (env, path, token = null) =>
	collector.fetch(
		new Request(`https://collector.example.test${path}`, {
			headers: token === null ? {} : { Authorization: `Bearer ${token}` },
		}),
		env,
	);

const COLUMNS = [
	"day",
	"install_id",
	"version",
	"runtime",
	"users_total",
	"users_active_1d",
	"users_active_7d",
	"users_active_30d",
	"mailboxes_total",
	"mailboxes_active_1d",
	"inbound_1d",
	"outbound_1d",
	"modules_enabled",
];

function insertDay(sqlite, day, id, overrides = {}) {
	const row = { ...heartbeat({ install_id: id }), ...overrides, day };
	row.modules_enabled = JSON.stringify(row.modules_enabled);
	sqlite.db
		.prepare(`INSERT INTO daily (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})`)
		.run(...COLUMNS.map((column) => row[column]));
}

const dailyCount = (sqlite, id) => sqlite.db.prepare("SELECT COUNT(*) AS n FROM daily WHERE install_id = ?").get(id).n;

test("heartbeats are stored once per install and day, without anything about the request", async (t) => {
	const { sqlite, env } = await setup(t);
	assert.equal((await collector.fetch(post(heartbeat()), env)).status, 204);
	assert.equal(
		(await collector.fetch(post(heartbeat({ users_total: "6-20", version: "2026.10.27.0" })), env)).status,
		204,
	);
	const daily = sqlite.db.prepare("SELECT * FROM daily").all();
	assert.equal(daily.length, 1);
	assert.equal(daily[0].day, today());
	assert.equal(daily[0].users_total, "6-20", "the latest report of the day wins");
	assert.equal(daily[0].version, "2026.10.27.0");
	assert.equal(daily[0].modules_enabled, '["calendar","drive"]');
	const dump = Buffer.from(await sqlite.dump()).toString("latin1");
	for (const leaked of ["203.0.113.9", "kite-test-agent", "mail.example.com"])
		assert.ok(!dump.includes(leaked), leaked);
});

test("bad requests are refused before anything is written", async (t) => {
	const { sqlite, env } = await setup(t);
	const status = async (request) => (await collector.fetch(request, env)).status;
	assert.equal(await status(post({ ...heartbeat(), extra: 1 })), 400);
	assert.equal(await status(post({ ...heartbeat({ telemetry_schema_version: 1 }), users_total: 3 })), 400);
	assert.equal(await status(post(heartbeat(), { "Content-Type": "text/plain" })), 415);
	assert.equal(await status(post(heartbeat(), { "Content-Length": "4096" })), 413);
	assert.equal(await status(new Request("https://collector.example.test/v1/heartbeat")), 405);
	assert.equal(await status(new Request("https://collector.example.test/")), 404);
	const answer = await collector.fetch(post({ ...heartbeat(), email: "owner@example.com" }), env);
	assert.deepEqual(await answer.json(), { error: "unknown_key" });
	assert.equal(sqlite.db.prepare("SELECT COUNT(*) AS n FROM daily").get().n, 0);
});

test("DELETE /v1/installs/<id> erases every report of that id and is rate-limited", async (t) => {
	const keys = [];
	let allow = true;
	const limiter = {
		limit: async (options) => {
			keys.push(options);
			return { success: allow };
		},
	};
	const { sqlite, env } = await setup(t, { ERASE_RATE_LIMIT: limiter });
	const other = idFor("b");
	for (const days of [0, 1, 40]) insertDay(sqlite, daysAgo(days), INSTALL_ID);
	insertDay(sqlite, daysAgo(0), other);

	const response = await erase(env, INSTALL_ID);
	assert.equal(response.status, 204);
	assert.equal(response.headers.get("Cache-Control"), "no-store");
	assert.equal(dailyCount(sqlite, INSTALL_ID), 0, "every day of that id");
	assert.equal(dailyCount(sqlite, other), 1, "other installs stay");
	assert.equal((await erase(env, INSTALL_ID)).status, 204, "the same answer when nothing is left");
	assert.equal((await erase(env, idFor("c"))).status, 204, "and for an id never seen");
	assert.deepEqual(keys.at(-1), { key: "203.0.113.9" }, "keyed per connecting address");
	await erase(env, INSTALL_ID, "DELETE", "198.51.100.7");
	assert.deepEqual(keys.at(-1), { key: "198.51.100.7" });

	const used = keys.length;
	assert.equal((await erase(env, "owner@example.com")).status, 400);
	assert.equal((await erase(env, INSTALL_ID.toUpperCase())).status, 400);
	assert.equal(keys.length, used, "a malformed id is refused before it uses up the limit");
	assert.equal((await erase(env, `${INSTALL_ID}/extra`)).status, 404);
	assert.equal((await erase(env, other, "GET")).status, 405);
	assert.equal((await erase(env, other, "POST")).status, 405);
	assert.equal(dailyCount(sqlite, other), 1);

	allow = false;
	assert.equal((await erase(env, other)).status, 429);
	assert.equal(dailyCount(sqlite, other), 1, "nothing is deleted over the limit");
	const dump = Buffer.from(await sqlite.dump()).toString("latin1");
	assert.ok(!dump.includes("203.0.113.9"), "the address is never stored");
});

const numbered = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Twelve installs that reported today: 9 on one version and 3 on another, 2 on Node, 2 with Drive and 100+ users. */
function seedPublic(sqlite, installs = 12) {
	for (let n = 0; n < installs; n += 1)
		insertDay(sqlite, daysAgo(0), numbered(n), {
			version: n < 9 ? "2026.10.26.0" : "2026.10.20.0",
			runtime: n < 2 ? "node" : "workers",
			users_total: n < 2 ? "100+" : "2-5",
			modules_enabled: n < 2 ? ["calendar", "drive"] : ["calendar"],
		});
}

test("the public summary shows totals and ranges, small counts as <5 and never an install id", async (t) => {
	const { sqlite, env } = await setup(t);
	assert.equal(SMALL_CELL, 5);
	seedPublic(sqlite);
	insertDay(sqlite, daysAgo(3), numbered(0)); // an earlier report of an install counted today
	insertDay(sqlite, daysAgo(45), numbered(99)); // outside the 30 days
	sqlite.db
		.prepare("INSERT INTO aggregates (day, dimension, value, installs) VALUES (?, 'installs', '', 7)")
		.run(daysAgo(200));

	const response = await get(env, "/v1/summary");
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("Cache-Control"), "public, max-age=3600");
	assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
	assert.match(response.headers.get("Content-Type"), /^application\/json/);
	const text = await response.text();
	for (const n of [0, 11, 99]) assert.ok(!text.includes(numbered(n)), "no install id");
	const body = JSON.parse(text);
	assert.equal(body.installs_30d, 12);
	assert.deepEqual(body.versions, [
		{ version: "2026.10.26.0", installs: 9 },
		{ version: "2026.10.20.0", installs: "<5" },
	]);
	assert.deepEqual(body.runtimes, [
		{ runtime: "workers", installs: 10 },
		{ runtime: "node", installs: "<5" },
	]);
	assert.deepEqual(body.modules, [
		{ module: "calendar", installs: 12 },
		{ module: "drive", installs: "<5" },
	]);
	assert.deepEqual(body.ranges.users_total, { "100+": "<5", "2-5": 10 });
	assert.deepEqual(body.ranges.inbound_1d, { "1-10": 12 });
	assert.equal(Object.keys(body.ranges).length, 8);
	assert.deepEqual(body.installs_by_day, [
		{ day: daysAgo(200), installs: 7 },
		{ day: daysAgo(45), installs: "<5" },
		{ day: daysAgo(3), installs: "<5" },
		{ day: daysAgo(0), installs: 12 },
	]);
	assert.equal(
		(await collector.fetch(new Request("https://collector.example.test/v1/summary", { method: "POST" }), env)).status,
		405,
	);
});

test("below ten installs in 30 days the public summary shows only their number", async (t) => {
	const { sqlite, env } = await setup(t);
	assert.equal(MIN_PUBLIC_INSTALLS, 10);
	seedPublic(sqlite, 9);
	const body = await (await get(env, "/v1/summary")).json();
	assert.deepEqual(Object.keys(body).sort(), ["generated_at", "installs_30d"]);
	assert.equal(body.installs_30d, 9);
	// The operator's stats keep the exact figures.
	const stats = await (await get(env, "/v1/stats", TOKEN)).json();
	assert.deepEqual(stats.runtimes, [
		{ runtime: "workers", installs: 7 },
		{ runtime: "node", installs: 2 },
	]);
});

test("the public summary is stored and recomputed by the daily cron, not on every request", async (t) => {
	const { sqlite, env } = await setup(t);
	seedPublic(sqlite);
	assert.equal((await (await get(env, "/v1/summary")).json()).installs_30d, 12, "computed once when none is stored");
	const queries = [];
	const counting = {
		...env,
		DB: new Proxy(sqlite, {
			get(target, property) {
				if (property === "prepare")
					return (sql) => {
						queries.push(sql);
						return target.prepare(sql);
					};
				const value = target[property];
				return typeof value === "function" ? value.bind(target) : value;
			},
		}),
	};
	insertDay(sqlite, daysAgo(0), numbered(50));
	assert.equal((await (await get(counting, "/v1/summary")).json()).installs_30d, 12, "the stored summary");
	assert.deepEqual(queries, ["SELECT body FROM summary_cache WHERE id = 1"], "one read per public request");

	const pending = [];
	await collector.scheduled({ scheduledTime: Date.now() }, env, { waitUntil: (promise) => pending.push(promise) });
	await Promise.all(pending);
	assert.equal((await (await get(env, "/v1/summary")).json()).installs_30d, 13, "refreshed by the cron");
});

test("stats need the bearer token and count distinct installs", async (t) => {
	const { sqlite, env } = await setup(t);
	assert.equal((await get(env, "/v1/stats")).status, 401);
	assert.equal((await get(env, "/v1/stats", "wrong")).status, 401);
	assert.equal((await get({ DB: sqlite }, "/v1/stats", TOKEN)).status, 401, "closed without STATS_TOKEN");
	assert.equal(
		(await collector.fetch(new Request("https://collector.example.test/v1/stats", { method: "POST" }), env)).status,
		405,
	);
	// a: today and yesterday; b: 5 days ago; c: 20 days ago; d: 60 days ago.
	[0, 5, 20, 60].forEach((days, index) => insertDay(sqlite, daysAgo(days), idFor("abcd"[index])));
	insertDay(sqlite, daysAgo(1), idFor("a"));

	const response = await get(env, "/v1/stats", TOKEN);
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("Cache-Control"), "no-store");
	const body = await response.json();
	assert.deepEqual(body.installs, { total: 4, active_1d: 1, active_7d: 2, active_30d: 3 });
	assert.equal(body.installs_30d, 3);
	assert.deepEqual(body.ranges.users_total, { "2-5": 3 });
});

test("after 90 days daily rows become aggregates without install ids", async (t) => {
	const { sqlite, env } = await setup(t);
	assert.equal(RAW_RETENTION_DAYS, 90);
	const old = daysAgo(120);
	insertDay(sqlite, old, idFor("a"), { runtime: "node", modules_enabled: ["calendar", "drive"] });
	insertDay(sqlite, old, idFor("b"), { users_total: "1", modules_enabled: ["drive"] });
	insertDay(sqlite, daysAgo(95), idFor("a"));
	insertDay(sqlite, daysAgo(89), idFor("a"));
	insertDay(sqlite, daysAgo(0), idFor("b"));

	await rollUpOldDays(env, Date.now());
	assert.deepEqual(
		sqlite.db
			.prepare("SELECT day FROM daily ORDER BY day")
			.all()
			.map((row) => row.day),
		[daysAgo(89), daysAgo(0)],
		"only the last 90 days keep their rows",
	);
	const aggregates = sqlite.db
		.prepare("SELECT day, dimension, value, installs FROM aggregates WHERE day = ? ORDER BY dimension, value")
		.all(old);
	assert.deepEqual(
		aggregates.filter(({ dimension }) =>
			["installs", "module", "runtime", "users_total", "version"].includes(dimension),
		),
		[
			{ day: old, dimension: "installs", value: "", installs: 2 },
			{ day: old, dimension: "module", value: "calendar", installs: 1 },
			{ day: old, dimension: "module", value: "drive", installs: 2 },
			{ day: old, dimension: "runtime", value: "node", installs: 1 },
			{ day: old, dimension: "runtime", value: "workers", installs: 1 },
			{ day: old, dimension: "users_total", value: "1", installs: 1 },
			{ day: old, dimension: "users_total", value: "2-5", installs: 1 },
			{ day: old, dimension: "version", value: "2026.10.26.0", installs: 2 },
		],
	);
	assert.equal(
		sqlite.db.prepare("SELECT COUNT(DISTINCT dimension) AS n FROM aggregates").get().n,
		12,
		"installs, version, runtime, module and the eight ranges",
	);
	const dump = Buffer.from(await sqlite.dump()).toString("latin1");
	assert.ok(!dump.includes(`'${old}','${idFor("a")}'`));

	await rollUpOldDays(env, Date.now());
	assert.equal(
		sqlite.db.prepare("SELECT installs FROM aggregates WHERE day = ? AND dimension = 'installs'").get(old).installs,
		2,
		"running again counts nothing twice",
	);
	const stats = await (await get(env, "/v1/stats", TOKEN)).json();
	assert.deepEqual(stats.installs_by_day.slice(0, 2), [
		{ day: old, installs: 2 },
		{ day: daysAgo(95), installs: 1 },
	]);
});

test("no statement has more compound terms than D1 allows", async (t) => {
	// D1 refuses a compound SELECT with more than five terms; local SQLite allows 500, so count them here.
	const { sqlite, env } = await setup(t);
	seedPublic(sqlite);
	const statements = [];
	const recording = {
		...env,
		DB: new Proxy(sqlite, {
			get(target, property) {
				if (property === "prepare")
					return (sql) => {
						statements.push(sql);
						return target.prepare(sql);
					};
				const value = target[property];
				return typeof value === "function" ? value.bind(target) : value;
			},
		}),
	};
	await collector.fetch(post(heartbeat()), recording);
	await get(recording, "/v1/summary");
	await get(recording, "/v1/stats", TOKEN);
	await erase(recording, INSTALL_ID);
	const pending = [];
	await collector.scheduled({ scheduledTime: Date.now() }, recording, {
		waitUntil: (promise) => pending.push(promise),
	});
	await Promise.all(pending);
	assert.ok(statements.length > 10);
	for (const sql of statements)
		assert.ok((sql.match(/\b(UNION|INTERSECT|EXCEPT)\b/gi) ?? []).length + 1 <= 5, sql.slice(0, 120));
});
