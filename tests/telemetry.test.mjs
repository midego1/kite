import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-telemetry-");
after(() => rmSync(outDir, { recursive: true, force: true }));

const source = (path) => fileURLToPath(import.meta.resolve(`../src/${path}`));
await build({
	entryPoints: {
		utils: source("lib/telemetry/telemetry-utils.ts"),
		state: source("lib/telemetry/state.ts"),
		heartbeat: source("lib/telemetry/heartbeat.ts"),
		erase: source("lib/telemetry/erase.ts"),
		collector: join(root, "deploy/telemetry-collector/src/validate.ts"),
		runtime: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	splitting: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	sourcemap: "inline",
	packages: "external",
	tsconfig: join(root, "tsconfig.json"),
	alias: { "cloudflare:workers": join(root, "server/runtime/cloudflare-workers.ts") },
	define: { "process.env.NEXT_PUBLIC_KITE_BUILD_VERSION": JSON.stringify("2026.10.26.0") },
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const {
	buildHeartbeatPayload,
	DEFAULT_TELEMETRY_URL,
	TELEMETRY_FIELDS,
	telemetryEraseUrl,
	telemetryForcedOff,
	telemetryUrl,
	utcDay,
} = await load("utils");
const { claimTelemetryDay, getTelemetryStatus, readTelemetryState, setTelemetryEnabled, TelemetryUnavailableError } =
	await load("state");
const { runTelemetryHeartbeat } = await load("heartbeat");
const { eraseAfterOptOut, eraseTelemetryInstall } = await load("erase");
const { parseHeartbeat } = await load("collector");
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");

const INSTALL_ID = "3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e";
const KEYS = [
	"telemetry_schema_version",
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
const COLLECTOR = "https://collector.example.test/v1/heartbeat";
const DEFAULT_COLLECTOR = "https://kite-telemetry.midego.net/v1/heartbeat";
/** Every heartbeat here goes to an injected fetcher; a real network call fails the test. */
globalThis.fetch = async () => {
	throw new Error("telemetry tests must not use the network");
};
/** Asserts a literal never appears in `text` (a regex, so it reads as text matching, not URL checking). */
const assertAbsent = (text, literal, message = literal) =>
	assert.doesNotMatch(text, new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), message);
const NOW = new Date("2026-10-26T02:00:00Z");
const seconds = (date) => Math.floor(date.getTime() / 1000);
const ago = (days) => seconds(NOW) - Math.round(days * 86_400);

function input(overrides = {}) {
	return {
		installId: INSTALL_ID,
		version: "2026.10.26.0",
		runtime: "workers",
		counts: {
			users_total: 3,
			users_active_1d: 1,
			users_active_7d: 2,
			users_active_30d: 3,
			mailboxes_total: 4,
			mailboxes_active_1d: 2,
			inbound_1d: 10,
			outbound_1d: 5,
		},
		modulesEnabled: ["calendar", "drive"],
		...overrides,
	};
}

/** The ranges `input()`'s counts are sent as. */
const INPUT_BUCKETS = {
	users_total: "2-5",
	users_active_1d: "1",
	users_active_7d: "2-5",
	users_active_30d: "2-5",
	mailboxes_total: "2-5",
	mailboxes_active_1d: "2-5",
	inbound_1d: "1-10",
	outbound_1d: "1-10",
};

test("the heartbeat payload has exactly the schema's keys, whatever else the input carries", () => {
	const payload = buildHeartbeatPayload({
		...input(),
		email: "owner@example.com",
		hostname: "mail.example.com",
		counts: { ...input().counts, user_id: "usr_1", APP_URL: "https://mail.example.com" },
	});
	assert.deepEqual(Object.keys(payload).sort(), [...KEYS].sort());
	assert.deepEqual(payload, {
		telemetry_schema_version: 2,
		install_id: INSTALL_ID,
		version: "2026.10.26.0",
		runtime: "workers",
		...INPUT_BUCKETS,
		modules_enabled: ["calendar", "drive"],
	});
	assert.doesNotMatch(JSON.stringify(payload), /example\.com/);
	assert.doesNotMatch(JSON.stringify(payload), /usr_1/);
	assert.deepEqual(
		TELEMETRY_FIELDS.map(({ key }) => key),
		KEYS,
		"the field list the owner sees is the payload",
	);
});

/** The ranges every count of a payload falls in when all counts are `value`. */
function rangesOf(value) {
	const counts = Object.fromEntries(KEYS.slice(4, 12).map((key) => [key, value]));
	const payload = buildHeartbeatPayload(input({ counts }));
	return { account: payload.users_total, message: payload.inbound_1d };
}
const messageBucket = (value) => rangesOf(value).message;
const accountBucket = (value) => rangesOf(value).account;

test("counts are sent as ranges, never as exact numbers", () => {
	const messages = [
		[0, "0"],
		[1, "1-10"],
		[10, "1-10"],
		[11, "11-100"],
		[100, "11-100"],
		[101, "101-1000"],
		[1000, "101-1000"],
		[1001, "1000+"],
		[1e12, "1000+"],
	];
	for (const [value, range] of messages) assert.equal(messageBucket(value), range, String(value));
	const accounts = [
		[0, "0"],
		[1, "1"],
		[2, "2-5"],
		[5, "2-5"],
		[6, "6-20"],
		[20, "6-20"],
		[21, "21-100"],
		[100, "21-100"],
		[101, "100+"],
		[5e9, "100+"],
	];
	for (const [value, range] of accounts) assert.equal(accountBucket(value), range, String(value));
	// Odd values count as zero, fractions round down.
	for (const value of [-4, Number.NaN, Number.POSITIVE_INFINITY, "7", null, { valueOf: () => 3 }, 0.9])
		assert.equal(accountBucket(value), "0", String(value));
	assert.equal(accountBucket(1.9), "1");

	const payload = buildHeartbeatPayload(
		input({
			counts: {
				users_total: 250,
				users_active_1d: 0,
				users_active_7d: 7,
				users_active_30d: 21,
				mailboxes_total: 1,
				mailboxes_active_1d: "3",
				inbound_1d: 54_321,
				outbound_1d: 101,
			},
		}),
	);
	assert.deepEqual(Object.fromEntries(KEYS.slice(4, 12).map((key) => [key, payload[key]])), {
		users_total: "100+",
		users_active_1d: "0",
		users_active_7d: "6-20",
		users_active_30d: "21-100",
		mailboxes_total: "1",
		mailboxes_active_1d: "0",
		inbound_1d: "1000+",
		outbound_1d: "101-1000",
	});
	assert.doesNotMatch(JSON.stringify(payload), /250|54321/);
});

test("runtime, version and modules are limited to known values", () => {
	const payload = buildHeartbeatPayload(
		input({
			runtime: "bare-metal",
			version: "2026.10.26.0 (abc1234) mail.example.com",
			modulesEnabled: ["drive", "secret-module", "drive", "calendar", 42, "mail.example.com"],
		}),
	);
	assert.equal(payload.runtime, "workers");
	assert.equal(payload.version, "unknown");
	assert.deepEqual(payload.modules_enabled, ["calendar", "drive"], "registry order, deduplicated");
	assert.equal(buildHeartbeatPayload(input({ runtime: "node" })).runtime, "node");
	assert.equal(buildHeartbeatPayload(input({ version: "development" })).version, "unknown");
});

test("no payload without a random install id", () => {
	for (const installId of [null, undefined, "", "owner@example.com", "3F2B8C1E-4D5A-4B6C-9D7E-8F9A0B1C2D3E", 7])
		assert.equal(buildHeartbeatPayload(input({ installId })), null, String(installId));
});

test("what Kite sends is exactly what the collector accepts", () => {
	const payload = buildHeartbeatPayload(
		input({ modulesEnabled: ["calendar", "booking", "templates", "import", "finance", "drive"] }),
	);
	assert.deepEqual(parseHeartbeat(JSON.stringify(payload)), { ok: true, value: payload });
});

test("KITE_TELEMETRY only ever forces statistics off", () => {
	for (const value of ["0", "false", "off", "no", " OFF ", "False"])
		assert.equal(telemetryForcedOff(value), true, value);
	for (const value of [undefined, "", "1", "true", "on", "yes", "2"])
		assert.equal(telemetryForcedOff(value), false, value);
});

test("the collector URL defaults to the project's collector, an empty override sends nothing, others must be https", () => {
	assert.equal(DEFAULT_TELEMETRY_URL, DEFAULT_COLLECTOR);
	assert.equal(new URL(DEFAULT_TELEMETRY_URL).origin, "https://kite-telemetry.midego.net");
	assert.equal(telemetryUrl(undefined), DEFAULT_COLLECTOR, "only an unset value means the default");
	assert.equal(telemetryUrl(""), null, "an empty value sends nothing");
	assert.equal(telemetryUrl("  "), null);
	assert.equal(telemetryUrl(COLLECTOR), COLLECTOR);
	for (const value of [
		"http://collector.example.test/v1/heartbeat",
		"https://user:pass@collector.example.test/",
		"not a url",
		"https://telemetry.example.invalid/",
	])
		assert.equal(telemetryUrl(value), null, value);
	assert.equal(utcDay(new Date("2026-10-26T23:59:59Z")), "2026-10-26");
});

test("the erasure address sits next to the heartbeat path", () => {
	assert.equal(
		telemetryEraseUrl(DEFAULT_COLLECTOR, INSTALL_ID),
		`https://kite-telemetry.midego.net/v1/installs/${INSTALL_ID}`,
	);
	assert.equal(
		telemetryEraseUrl("https://stats.example.test/kite/v1/heartbeat", INSTALL_ID),
		`https://stats.example.test/kite/v1/installs/${INSTALL_ID}`,
	);
	for (const id of ["../../admin", "", "3F2B8C1E-4D5A-4B6C-9D7E-8F9A0B1C2D3E", null])
		assert.equal(telemetryEraseUrl(DEFAULT_COLLECTOR, id), null, String(id));
});

async function setup(t) {
	const sqlite = new SqliteDatabase(":memory:");
	t.after(() => sqlite.db.close());
	await applyMigrations(sqlite, join(root, "drizzle/migrations"));
	return sqlite;
}

function seed(sqlite) {
	const insert = (sql, ...values) => sqlite.db.prepare(sql).run(...values);
	for (const [id, disabled] of [
		["usr_a", 0],
		["usr_b", 0],
		["usr_c", 0],
		["usr_d", 1],
	])
		insert(
			"INSERT INTO users (id, email, password_hash, name, disabled, created_at) VALUES (?, ?, 'hash', 'Name', ?, 1)",
			id,
			`${id}@example.com`,
			disabled,
		);
	insert(
		"INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('dom_1', 'usr_a', 'example.com', 'zone', 'active', 1)",
	);
	for (const id of ["mbx_1", "mbx_2", "mbx_3"])
		insert(
			"INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES (?, 'usr_a', 'dom_1', ?, 1)",
			id,
			id,
		);
	// usr_a: session today; usr_b: audited action 3 days ago; usr_c: audited action 20 days ago and 40 days ago.
	insert(
		"INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES ('ses_1', 'usr_a', 'h1', ?, ?)",
		ago(-30),
		ago(0.1),
	);
	insert(
		"INSERT INTO audit_logs (id, actor_user_id, action, created_at) VALUES ('aud_1', 'usr_b', 'email.read', ?)",
		ago(3),
	);
	insert(
		"INSERT INTO audit_logs (id, actor_user_id, action, created_at) VALUES ('aud_2', 'usr_c', 'email.send', ?)",
		ago(20),
	);
	insert(
		"INSERT INTO audit_logs (id, actor_user_id, action, created_at) VALUES ('aud_3', 'usr_c', 'auth.login', ?)",
		ago(40),
	);
	insert("INSERT INTO audit_logs (id, actor_user_id, action, created_at) VALUES ('aud_4', NULL, 'setup', ?)", ago(0.1));
	const message = (id, mailboxId, direction, status, at) =>
		insert(
			"INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at) VALUES (?, 'usr_a', ?, ?, 'a@example.com', 'b@example.com', 'Hi', 'Body', ?, ?)",
			id,
			mailboxId,
			direction,
			status,
			at,
		);
	message("msg_1", "mbx_1", "inbound", "received", ago(0.5));
	message("msg_2", "mbx_1", "inbound", "spam", ago(0.2));
	message("msg_3", "mbx_2", "outbound", "sent", ago(0.3));
	message("msg_4", "mbx_3", "outbound", "draft", ago(0.3));
	message("msg_5", "mbx_3", "inbound", "received", ago(2));
	// Not delivered: neither counts as sent nor makes mbx_3 active.
	message("msg_6", "mbx_3", "outbound", "queued", ago(0.1));
	message("msg_7", "mbx_3", "outbound", "failed", ago(0.1));
}

test("counts come from users, sessions, audit rows and recent messages", async (t) => {
	const sqlite = await setup(t);
	seed(sqlite);
	// The exact counts never leave the install; read them where the count query answers.
	let counted = null;
	const DB = new Proxy(sqlite, {
		get(target, property) {
			if (property === "prepare")
				return (sql) => {
					const statement = target.prepare(sql);
					if (!sql.startsWith("WITH activity")) return statement;
					return {
						bind: (...values) => ({
							first: async () => (counted = await statement.bind(...values).first()),
						}),
					};
				};
			const value = target[property];
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const env = { DB, KITE_TELEMETRY_URL: COLLECTOR };
	await setTelemetryEnabled(env, true);
	const { requests, fetcher } = recorder();
	assert.equal(await runTelemetryHeartbeat(env, NOW, fetcher), "sent");
	assert.deepEqual(counted, {
		users_total: 3,
		users_active_1d: 1,
		users_active_7d: 2,
		users_active_30d: 3,
		mailboxes_total: 3,
		mailboxes_active_1d: 2,
		inbound_1d: 2,
		outbound_1d: 1,
	});
	const { telemetry_schema_version, install_id, version, runtime, modules_enabled, ...ranges } = requests[0].body;
	assert.deepEqual(ranges, {
		users_total: "2-5",
		users_active_1d: "1",
		users_active_7d: "2-5",
		users_active_30d: "2-5",
		mailboxes_total: "2-5",
		mailboxes_active_1d: "2-5",
		inbound_1d: "1-10",
		outbound_1d: "1-10",
	});
});

const UNDECIDED = {
	available: true,
	noticeAvailable: true,
	enabled: false,
	decision: null,
	installId: null,
	lastSentDay: null,
	startDay: null,
	noticeDismissed: false,
};

test("statistics start undecided and off; opting in makes an install id and opting out deletes it", async (t) => {
	const sqlite = await setup(t);
	const env = { DB: sqlite };
	assert.deepEqual(await readTelemetryState(env), UNDECIDED);
	await setTelemetryEnabled(env, true);
	const on = await readTelemetryState(env);
	assert.equal(on.enabled, true);
	assert.match(on.installId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	await setTelemetryEnabled(env, true);
	assert.equal((await readTelemetryState(env)).installId, on.installId, "stays while on");
	assert.equal(await claimTelemetryDay(env, "2026-10-26"), true);
	assert.equal(await claimTelemetryDay(env, "2026-10-26"), false, "once per day");
	assert.equal(await claimTelemetryDay(env, "2026-10-27"), true);
	assert.equal(on.decision, "on");
	await setTelemetryEnabled(env, false);
	assert.deepEqual(await readTelemetryState(env), { ...UNDECIDED, decision: "off" });
	assert.equal(await claimTelemetryDay(env, "2026-10-28"), false, "never while off");
	await setTelemetryEnabled(env, true);
	assert.notEqual((await readTelemetryState(env)).installId, on.installId, "a new id after opting in again");
	await setTelemetryEnabled(env, true);
	const forced = { ...env, KITE_TELEMETRY: "0" };
	const before = await setTelemetryEnabled(forced, false);
	assert.equal(before.enabled, true, "KITE_TELEMETRY=0 never stops an opt-out");
	assert.equal((await readTelemetryState(env)).installId, null);
	await setTelemetryEnabled(env, true);
	const status = await getTelemetryStatus({ ...env, KITE_TELEMETRY: "off", KITE_TELEMETRY_URL: COLLECTOR });
	assert.equal(status.forcedOff, true);
	assert.equal(status.endpoint, COLLECTOR);
	assert.equal((await getTelemetryStatus(env)).endpoint, DEFAULT_COLLECTOR);
	assert.equal((await getTelemetryStatus({ ...env, KITE_TELEMETRY_URL: "http://plain.example.test/" })).endpoint, null);
	assert.equal((await getTelemetryStatus({ ...env, KITE_TELEMETRY_URL: "" })).endpoint, null);
});

test("before migration 0071 statistics are off and cannot be turned on", async (t) => {
	const sqlite = await setup(t);
	sqlite.db.exec("DROP TABLE telemetry_state");
	const env = { DB: sqlite };
	assert.equal((await readTelemetryState(env)).available, false);
	await assert.rejects(setTelemetryEnabled(env, true), TelemetryUnavailableError);
	const requests = [];
	const outcome = await runTelemetryHeartbeat({ ...env, KITE_TELEMETRY_URL: COLLECTOR }, NOW, async (...args) => {
		requests.push(args);
		return new Response(null, { status: 204 });
	});
	assert.equal(outcome, "disabled");
	assert.equal(requests.length, 0);
});

async function captureLogs(run) {
	const lines = [];
	const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };
	for (const level of Object.keys(original)) console[level] = (...args) => lines.push(args.join(" "));
	try {
		return { result: await run(), lines };
	} finally {
		Object.assign(console, original);
	}
}

function recorder(answer = () => new Response("collector says hi from 203.0.113.9", { status: 202 })) {
	const requests = [];
	const fetcher = async (url, init) => {
		requests.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
		return answer({ url, init });
	};
	return { requests, fetcher };
}

test("the heartbeat sends one allowlisted report a day, only when opted in", async (t) => {
	const sqlite = await setup(t);
	seed(sqlite);
	const env = { DB: sqlite, KITE_TELEMETRY_URL: COLLECTOR };
	const { requests, fetcher } = recorder();

	assert.equal(await runTelemetryHeartbeat(env, NOW, fetcher), "disabled", "nothing without a decision");
	await setTelemetryEnabled(env, true);
	assert.equal(
		await runTelemetryHeartbeat(
			{ DB: sqlite, KITE_TELEMETRY_URL: "https://kite-telemetry.e2e.invalid/" },
			NOW,
			fetcher,
		),
		"no_endpoint",
	);
	assert.equal(await runTelemetryHeartbeat({ ...env, KITE_TELEMETRY: "0" }, NOW, fetcher), "forced_off");
	assert.equal(requests.length, 0);

	const { result, lines } = await captureLogs(() => runTelemetryHeartbeat(env, NOW, fetcher));
	assert.equal(result, "sent");
	assert.equal(requests.length, 1);
	const [request] = requests;
	assert.equal(request.url, COLLECTOR);
	assert.equal(request.init.method, "POST");
	assert.equal(request.init.redirect, "error");
	assert.deepEqual(Object.keys(request.init.headers), ["Content-Type"]);
	assert.deepEqual(Object.keys(request.body).sort(), [...KEYS].sort());
	assert.equal(request.body.install_id, (await readTelemetryState(env)).installId);
	assert.equal(request.body.version, "2026.10.26.0");
	assert.equal(request.body.runtime, "workers");
	assert.equal(request.body.users_total, "2-5");
	assert.equal(request.body.inbound_1d, "1-10");
	assert.deepEqual(request.body.modules_enabled, ["calendar", "booking", "templates", "import", "finance", "drive"]);
	assert.equal(parseHeartbeat(request.init.body).ok, true);
	for (const forbidden of ["example.com", "usr_", "mbx_", "dom_", "203.0.113.9"])
		assertAbsent(request.init.body, forbidden);
	assertAbsent(lines.join("\n"), "203.0.113.9", "the response is never logged");

	assert.equal(await runTelemetryHeartbeat(env, NOW, fetcher), "already_sent");
	assert.equal(await runTelemetryHeartbeat(env, new Date("2026-10-26T23:00:00Z"), fetcher), "already_sent");
	assert.equal(requests.length, 1);
	assert.equal(
		await runTelemetryHeartbeat({ ...env, KITE_RUNTIME: "node" }, new Date("2026-10-27T02:00:00Z"), fetcher),
		"sent",
	);
	assert.equal(requests[1].body.runtime, "node");
});

test("a failing heartbeat never throws, logs a fixed message and waits for the next day", async (t) => {
	const sqlite = await setup(t);
	const env = { DB: sqlite, KITE_TELEMETRY_URL: COLLECTOR };
	await setTelemetryEnabled(env, true);
	const failing = recorder(() => {
		throw new Error("connect ECONNREFUSED 203.0.113.9 owner@example.com");
	});
	const { result, lines } = await captureLogs(() => runTelemetryHeartbeat(env, NOW, failing.fetcher));
	assert.equal(result, "failed");
	const output = lines.join("\n");
	assert.match(output, /telemetry\.heartbeat_failed/);
	for (const leaked of ["ECONNREFUSED", "203.0.113.9", "owner@example.com", "install"]) assertAbsent(output, leaked);
	assert.equal(await runTelemetryHeartbeat(env, NOW, failing.fetcher), "already_sent", "no retry the same day");
	assert.equal(failing.requests.length, 1);

	const rejecting = recorder(() => new Response("bad request: field x", { status: 400 }));
	assert.equal(await runTelemetryHeartbeat(env, new Date("2026-10-27T02:00:00Z"), rejecting.fetcher), "rejected");

	sqlite.db.exec("DROP TABLE audit_logs");
	assert.equal(await runTelemetryHeartbeat(env, new Date("2026-10-28T02:00:00Z"), rejecting.fetcher), "failed");
});

test("an opt-out while the counts are read stops the report", async (t) => {
	const sqlite = await setup(t);
	seed(sqlite);
	for (const [label, change] of [
		["off", "UPDATE telemetry_state SET enabled = 0, install_id = NULL"],
		["off and on again", "UPDATE telemetry_state SET install_id = '9f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e'"],
	]) {
		await setTelemetryEnabled({ DB: sqlite }, false);
		await setTelemetryEnabled({ DB: sqlite }, true);
		// The owner's change lands while the heartbeat runs its count query.
		const DB = new Proxy(sqlite, {
			get(target, property) {
				if (property === "prepare")
					return (sql) => {
						if (sql.startsWith("WITH activity")) target.db.exec(change);
						return target.prepare(sql);
					};
				const value = target[property];
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const { requests, fetcher } = recorder();
		const outcome = await runTelemetryHeartbeat({ DB, KITE_TELEMETRY_URL: COLLECTOR }, NOW, fetcher);
		assert.equal(outcome, "disabled", label);
		assert.equal(requests.length, 0, label);
	}
});

test("turning statistics off asks the collector to erase the old id's reports", async (t) => {
	const sqlite = await setup(t);
	const env = { DB: sqlite, KITE_TELEMETRY_URL: COLLECTOR };
	const { requests, fetcher } = recorder(() => new Response(null, { status: 204 }));

	// Never reported: nothing to erase, no request.
	await setTelemetryEnabled(env, true);
	const unsent = await setTelemetryEnabled(env, false);
	assert.deepEqual(await eraseAfterOptOut(env, unsent, fetcher), { outcome: "not_needed", installId: null });
	assert.equal(requests.length, 0);

	await setTelemetryEnabled(env, true);
	assert.equal(await runTelemetryHeartbeat(env, NOW, fetcher), "sent");
	const before = await setTelemetryEnabled(env, false);
	assert.equal((await readTelemetryState(env)).installId, null, "the local id is gone before the request");
	const { result, lines } = await captureLogs(() => eraseAfterOptOut(env, before, fetcher));
	assert.deepEqual(result, { outcome: "erased", installId: before.installId });
	const [, erasure] = requests;
	assert.equal(erasure.url, `https://collector.example.test/v1/installs/${before.installId}`);
	assert.equal(erasure.init.method, "DELETE");
	assert.equal(erasure.init.redirect, "error");
	assert.equal(erasure.init.body, undefined);
	assert.equal(erasure.init.headers, undefined);
	assert.match(lines.join("\n"), /telemetry\.erase_sent/);
	assertAbsent(lines.join("\n"), before.installId, "the id is never logged");
});

test("a failed erasure never blocks the opt-out and returns the id for a manual request", async (t) => {
	const sqlite = await setup(t);
	const env = { DB: sqlite, KITE_TELEMETRY_URL: COLLECTOR };
	const previous = { installId: INSTALL_ID, lastSentDay: "2026-10-26" };
	for (const [label, answer] of [
		["network error", () => Promise.reject(new Error("connect ECONNREFUSED 203.0.113.9"))],
		["rate limited", () => new Response("slow down 203.0.113.9", { status: 429 })],
	]) {
		const { requests, fetcher } = recorder(answer);
		const { result, lines } = await captureLogs(() => eraseAfterOptOut(env, previous, fetcher));
		assert.deepEqual(result, { outcome: "failed", installId: INSTALL_ID }, label);
		assert.equal(requests.length, 1, label);
		const output = lines.join("\n");
		assert.match(output, /telemetry\.erase_failed/, label);
		for (const leaked of ["ECONNREFUSED", "203.0.113.9", INSTALL_ID]) assertAbsent(output, leaked);
	}
	// KITE_TELEMETRY_URL emptied since: no request at all, and the owner gets the id.
	const { requests, fetcher } = recorder();
	assert.deepEqual(await eraseAfterOptOut({ KITE_TELEMETRY_URL: "" }, previous, fetcher), {
		outcome: "failed",
		installId: INSTALL_ID,
	});
	assert.equal(requests.length, 0);
	assert.equal(await eraseTelemetryInstall(COLLECTOR, "not-an-id", fetcher), "no_endpoint");
	assert.equal(requests.length, 0);
});

test("an opt-out that lands while a report is on its way erases that report too", async (t) => {
	const sqlite = await setup(t);
	const env = { DB: sqlite, KITE_TELEMETRY_URL: COLLECTOR };
	await setTelemetryEnabled(env, true);
	const { installId } = await readTelemetryState(env);
	let optedOut = false;
	const { requests, fetcher } = recorder(async ({ init }) => {
		// The owner turns statistics off after the last check but before the collector answers.
		if (init.method === "POST" && !optedOut) {
			optedOut = true;
			await setTelemetryEnabled(env, false);
		}
		return new Response(null, { status: 204 });
	});
	assert.equal(await runTelemetryHeartbeat(env, NOW, fetcher), "sent");
	assert.deepEqual(
		requests.map(({ url, init }) => [init.method, url]),
		[
			["POST", COLLECTOR],
			["DELETE", `https://collector.example.test/v1/installs/${installId}`],
		],
	);
});

test("without an override every request goes to kite-telemetry.midego.net and never follows a redirect", async (t) => {
	const sqlite = await setup(t);
	const env = { DB: sqlite };
	await setTelemetryEnabled(env, true);
	const { requests, fetcher } = recorder(() => new Response(null, { status: 204 }));
	assert.equal(await runTelemetryHeartbeat(env, NOW, fetcher), "sent");
	await eraseAfterOptOut(env, await setTelemetryEnabled(env, false), fetcher);
	assert.equal(requests.length, 2);
	for (const { url, init } of requests) {
		assert.equal(new URL(url).origin, "https://kite-telemetry.midego.net");
		assert.equal(init.redirect, "error");
	}
});
