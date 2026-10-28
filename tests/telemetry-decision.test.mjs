import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { copyMigrationsBefore } from "./support/module-database.mjs";

/**
 * Who decides whether usage statistics are sent, and when: the setup switch for a new install, the one-time notice
 * and its start day for an install that never chose, an explicit off that nothing turns on again, and
 * `KITE_TELEMETRY` / `KITE_TELEMETRY_URL` over all of it. Every heartbeat goes to an injected recorder.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-telemetry-decision-");
after(() => rmSync(outDir, { recursive: true, force: true }));

const source = (path) => fileURLToPath(import.meta.resolve(`../src/${path}`));
await build({
	entryPoints: {
		utils: source("lib/telemetry/telemetry-utils.ts"),
		notice: source("lib/telemetry/notice-utils.ts"),
		state: source("lib/telemetry/state.ts"),
		heartbeat: source("lib/telemetry/heartbeat.ts"),
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
	setupTelemetryDecision,
	telemetryDayLabel,
	telemetryNoticeDue,
	telemetryNoticeText,
	telemetryStartDay,
	telemetryStartDayReached,
} = await load("utils");
const { telemetryStartsLater, telemetrySwitchOn, usageStatisticsSetupHint } = await load("notice");
const {
	applyTelemetryStartDay,
	getTelemetryStatus,
	markTelemetryNotice,
	readTelemetryState,
	recordSetupTelemetryChoice,
	setTelemetryEnabled,
	TelemetryUnavailableError,
} = await load("state");
const { runTelemetryHeartbeat } = await load("heartbeat");
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");

globalThis.fetch = async () => {
	throw new Error("telemetry tests must not use the network");
};

const COLLECTOR = "https://collector.example.test/v1/heartbeat";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DAY_MS = 86_400_000;
/** The notice is first seen at 15:30 UTC on 28 October; its start day is 12 November. */
const SEEN = new Date("2026-10-28T15:30:00Z");
const START_DAY = "2026-11-12";
const at = (day, time = "02:00:00") => new Date(`${day}T${time}Z`);
const choice = (overrides = {}) => ({ decision: null, startDay: null, noticeDismissed: false, ...overrides });

async function database(t, dir = join(root, "drizzle/migrations")) {
	const sqlite = new SqliteDatabase(":memory:");
	t.after(() => sqlite.db.close());
	await applyMigrations(sqlite, dir);
	return sqlite;
}

function recorder() {
	const requests = [];
	const fetcher = async (url, init) => {
		requests.push({ url, body: init.body ? JSON.parse(init.body) : null });
		return new Response(null, { status: 204 });
	};
	return { requests, fetcher };
}

/** Runs the daily heartbeat at 02:00 UTC on every day from `from` (inclusive) to `to` (exclusive). */
async function everyDay(env, from, to, fetcher) {
	const outcomes = new Set();
	for (let time = at(from).getTime(); time < at(to).getTime(); time += DAY_MS)
		outcomes.add(await runTelemetryHeartbeat(env, new Date(time), fetcher));
	return [...outcomes];
}

test("the start day is the UTC day after 14 full days, named the same everywhere", () => {
	assert.equal(telemetryStartDay(SEEN), START_DAY);
	assert.equal(telemetryStartDay(new Date("2026-10-28T00:00:00Z")), START_DAY);
	assert.equal(telemetryStartDay(new Date("2026-10-28T23:59:59Z")), START_DAY);
	// The first heartbeat (02:00 on the start day) is always at least 14 days after the notice.
	const latest = new Date("2026-10-28T23:59:59Z");
	assert.ok(at(telemetryStartDay(latest)).getTime() - latest.getTime() >= 14 * DAY_MS);
	assert.equal(telemetryDayLabel(START_DAY), "12 November 2026");
	assert.equal(
		telemetryNoticeText(START_DAY),
		"Kite will start sending usage statistics on 12 November 2026 unless you turn them off.",
	);
});

test("the rules: only an undecided install starts, only from a start day it was told about", () => {
	assert.equal(telemetryStartDayReached(choice(), "2027-01-01", false), false, "never told: never starts");
	assert.equal(telemetryStartDayReached(choice({ startDay: START_DAY }), "2026-11-11", false), false);
	assert.equal(telemetryStartDayReached(choice({ startDay: START_DAY }), START_DAY, false), true);
	assert.equal(
		telemetryStartDayReached(choice({ startDay: START_DAY, noticeDismissed: true }), START_DAY, false),
		true,
	);
	assert.equal(telemetryStartDayReached(choice({ startDay: START_DAY }), START_DAY, true), false, "KITE_TELEMETRY");
	assert.equal(
		telemetryStartDayReached(choice({ decision: "off", startDay: START_DAY }), "2030-01-01", false),
		false,
		"an explicit off stays off",
	);

	const context = { noticeAvailable: true, forcedOff: false, endpoint: COLLECTOR };
	assert.equal(telemetryNoticeDue(choice(), context), true);
	assert.equal(telemetryNoticeDue(choice({ startDay: START_DAY }), context), true, "until chosen or dismissed");
	assert.equal(telemetryNoticeDue(choice({ noticeDismissed: true }), context), false);
	assert.equal(telemetryNoticeDue(choice({ decision: "on" }), context), false);
	assert.equal(telemetryNoticeDue(choice({ decision: "off" }), context), false);
	assert.equal(telemetryNoticeDue(choice(), { ...context, forcedOff: true }), false);
	assert.equal(telemetryNoticeDue(choice(), { ...context, endpoint: null }), false, "nothing would be sent");
	assert.equal(telemetryNoticeDue(choice(), { ...context, noticeAvailable: false }), false);

	assert.equal(setupTelemetryDecision(true, false), "on");
	assert.equal(setupTelemetryDecision(false, false), "off");
	assert.equal(setupTelemetryDecision(undefined, false), null, "no switch: undecided, so the notice follows");
	assert.equal(setupTelemetryDecision("yes", false), null);
	assert.equal(setupTelemetryDecision(true, true), null, "KITE_TELEMETRY=0 records nothing");
	assert.equal(setupTelemetryDecision(false, true), null);

	const status = { enabled: false, decision: null, startDay: START_DAY, forcedOff: false };
	assert.equal(telemetryStartsLater(status), true);
	assert.equal(telemetrySwitchOn(status), true, "on by default until the start day");
	assert.equal(telemetrySwitchOn({ ...status, decision: "off", startDay: null }), false);
	assert.equal(telemetrySwitchOn({ ...status, startDay: null }), false);
	assert.equal(telemetrySwitchOn({ ...status, enabled: true, decision: "on" }), true);
	assert.match(usageStatisticsSetupHint({ forcedOff: true, endpoint: COLLECTOR, checked: true }), /KITE_TELEMETRY/);
	assert.match(usageStatisticsSetupHint({ forcedOff: false, endpoint: null, checked: true }), /nothing is sent/);
	assert.match(usageStatisticsSetupHint({ forcedOff: false, endpoint: COLLECTOR, checked: false }), /no install ID/);
});

test("a new install that finishes setup with the switch on gets an id and reports from the next night", async (t) => {
	const sqlite = await database(t);
	const env = { DB: sqlite, KITE_TELEMETRY_URL: COLLECTOR };
	const { requests, fetcher } = recorder();
	// Before setup completes there is no decision: nothing is sent, however long it takes.
	assert.deepEqual(await everyDay(env, "2026-10-01", "2026-12-31", fetcher), ["disabled"]);
	assert.equal((await readTelemetryState(env)).installId, null, "no id before setup completes");

	assert.equal(await recordSetupTelemetryChoice(env, true, SEEN), "on");
	const state = await readTelemetryState(env);
	assert.equal(state.decision, "on");
	assert.equal(state.enabled, true);
	assert.match(state.installId, UUID);
	const status = await getTelemetryStatus(env, SEEN);
	assert.equal(status.notice, false, "the setup told the owner: no notice");
	assert.equal(await runTelemetryHeartbeat(env, at("2026-10-29"), fetcher), "sent");
	assert.equal(requests.length, 1);
	assert.equal(requests[0].body.install_id, state.installId);
	assert.equal(await recordSetupTelemetryChoice(env, false, SEEN), null, "never overwrites a choice");
	assert.equal((await readTelemetryState(env)).decision, "on");
});

test("a new install that turns the switch off at setup has no id and never sends", async (t) => {
	const sqlite = await database(t);
	const env = { DB: sqlite, KITE_TELEMETRY_URL: COLLECTOR };
	const { requests, fetcher } = recorder();
	assert.equal(await recordSetupTelemetryChoice(env, false, SEEN), "off");
	const status = await getTelemetryStatus(env, SEEN);
	assert.deepEqual(
		{ enabled: status.enabled, decision: status.decision, installId: status.installId, notice: status.notice },
		{ enabled: false, decision: "off", installId: null, notice: false },
	);
	await markTelemetryNotice(env, "shown", SEEN);
	assert.equal((await readTelemetryState(env)).startDay, null, "no notice, no start day");
	assert.deepEqual(await everyDay(env, "2026-10-29", "2027-03-01", fetcher), ["disabled"]);
	assert.equal(requests.length, 0);
	assert.equal((await readTelemetryState(env)).installId, null);
});

test("a setup without the switch, or under KITE_TELEMETRY=0, records nothing and leaves the notice", async (t) => {
	const sqlite = await database(t);
	const env = { DB: sqlite, KITE_TELEMETRY_URL: COLLECTOR };
	assert.equal(await recordSetupTelemetryChoice(env, undefined, SEEN), null);
	assert.equal(await recordSetupTelemetryChoice({ ...env, KITE_TELEMETRY: "0" }, true, SEEN), null);
	const state = await readTelemetryState(env);
	assert.equal(state.decision, null);
	assert.equal(state.installId, null);
	assert.equal((await getTelemetryStatus(env, SEEN)).notice, true);
});

test("an existing install is told first and sends nothing until the start day", async (t) => {
	const sqlite = await database(t);
	const env = { DB: sqlite, KITE_TELEMETRY_URL: COLLECTOR };
	const { requests, fetcher } = recorder();
	const before = await getTelemetryStatus(env, SEEN);
	assert.deepEqual(
		{ notice: before.notice, startDay: before.startDay, enabled: before.enabled, decision: before.decision },
		{ notice: true, startDay: null, enabled: false, decision: null },
	);
	// Undecided and never told: nothing is ever sent and the clock never starts.
	assert.deepEqual(await everyDay(env, "2026-09-01", "2026-10-28", fetcher), ["disabled"]);

	await markTelemetryNotice(env, "shown", SEEN);
	const shown = await getTelemetryStatus(env, SEEN);
	assert.equal(shown.startDay, START_DAY);
	assert.equal(shown.notice, true, "still shown until chosen or dismissed");
	await markTelemetryNotice(env, "shown", new Date("2026-11-05T10:00:00Z"));
	assert.equal((await readTelemetryState(env)).startDay, START_DAY, "seeing it again never moves the day");

	assert.deepEqual(await everyDay(env, "2026-10-29", START_DAY, fetcher), ["disabled"]);
	assert.equal(requests.length, 0, "nothing during the 14 days");
	assert.equal((await readTelemetryState(env)).installId, null, "no id during the 14 days");

	assert.equal(await runTelemetryHeartbeat(env, at(START_DAY), fetcher), "sent");
	const after = await readTelemetryState(env);
	assert.equal(after.decision, "on");
	assert.match(after.installId, UUID);
	assert.equal(requests[0].body.install_id, after.installId);
	assert.equal((await getTelemetryStatus(env, at(START_DAY))).notice, false);
});

test("dismissing the notice keeps its start day; Keep on starts at once; Turn off is final", async (t) => {
	const { fetcher, requests } = recorder();
	const dismissed = { DB: await database(t), KITE_TELEMETRY_URL: COLLECTOR };
	await markTelemetryNotice(dismissed, "shown", SEEN);
	await markTelemetryNotice(dismissed, "dismissed", new Date("2026-10-30T09:00:00Z"));
	const status = await getTelemetryStatus(dismissed, SEEN);
	assert.deepEqual({ notice: status.notice, startDay: status.startDay }, { notice: false, startDay: START_DAY });
	assert.equal(await runTelemetryHeartbeat(dismissed, at("2026-11-11"), fetcher), "disabled");
	assert.equal(await runTelemetryHeartbeat(dismissed, at(START_DAY), fetcher), "sent");

	const keptOn = { DB: await database(t), KITE_TELEMETRY_URL: COLLECTOR };
	await markTelemetryNotice(keptOn, "shown", SEEN);
	await setTelemetryEnabled(keptOn, true);
	assert.equal((await getTelemetryStatus(keptOn, SEEN)).notice, false);
	assert.equal(await runTelemetryHeartbeat(keptOn, at("2026-10-29"), fetcher), "sent");

	const turnedOff = { DB: await database(t), KITE_TELEMETRY_URL: COLLECTOR };
	await markTelemetryNotice(turnedOff, "shown", SEEN);
	await setTelemetryEnabled(turnedOff, false);
	const off = await getTelemetryStatus(turnedOff, SEEN);
	assert.deepEqual(
		{ notice: off.notice, decision: off.decision, startDay: off.startDay, installId: off.installId },
		{ notice: false, decision: "off", startDay: null, installId: null },
	);
	const sent = requests.length;
	assert.deepEqual(await everyDay(turnedOff, "2026-10-29", "2027-06-01", fetcher), ["disabled"]);
	assert.equal(await applyTelemetryStartDay(turnedOff, at("2027-06-01")), false);
	await markTelemetryNotice(turnedOff, "shown", at("2027-06-01"));
	assert.equal((await getTelemetryStatus(turnedOff, at("2027-06-01"))).decision, "off", "never re-enabled");
	assert.equal(requests.length, sent);
});

test("an owner who turned statistics off before the upgrade stays off; one who turned them on stays on", async (t) => {
	const scratch = makeBundleDirectory("kite-telemetry-decision-migrations-");
	t.after(() => rmSync(scratch, { recursive: true, force: true }));
	const before0074 = copyMigrationsBefore(scratch, 74);
	const { fetcher, requests } = recorder();
	for (const [enabled, decision] of [
		[0, "off"],
		[1, "on"],
	]) {
		const sqlite = await database(t, before0074);
		const env = { DB: sqlite, KITE_TELEMETRY_URL: COLLECTOR };
		sqlite.db
			.prepare("INSERT INTO telemetry_state (id, enabled, install_id, updated_at) VALUES ('default', ?, ?, 1)")
			.run(enabled, enabled ? "3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e" : null);
		// Before 0074: a row is the owner's choice, the notice cannot be stored and is never shown.
		const legacy = await readTelemetryState(env);
		assert.deepEqual(
			{ decision: legacy.decision, noticeAvailable: legacy.noticeAvailable },
			{ decision, noticeAvailable: false },
		);
		assert.equal((await getTelemetryStatus(env, SEEN)).notice, false);
		await assert.rejects(markTelemetryNotice(env, "shown", SEEN), TelemetryUnavailableError);

		await applyMigrations(sqlite, join(root, "drizzle/migrations"));
		const upgraded = await getTelemetryStatus(env, SEEN);
		assert.deepEqual({ decision: upgraded.decision, notice: upgraded.notice }, { decision, notice: false });
		await markTelemetryNotice(env, "shown", SEEN);
		assert.equal((await readTelemetryState(env)).startDay, null);
		await everyDay(env, "2026-10-29", "2027-01-01", fetcher);
		assert.equal((await readTelemetryState(env)).decision, decision);
	}
	assert.ok(
		requests.length > 0 && requests.every(({ body }) => body.install_id === "3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e"),
	);
});

test("before migration 0074 the switch still works and nothing starts by itself", async (t) => {
	const scratch = makeBundleDirectory("kite-telemetry-decision-0073-");
	t.after(() => rmSync(scratch, { recursive: true, force: true }));
	const sqlite = await database(t, copyMigrationsBefore(scratch, 74));
	const env = { DB: sqlite, KITE_TELEMETRY_URL: COLLECTOR };
	const { fetcher, requests } = recorder();
	assert.equal((await getTelemetryStatus(env, SEEN)).notice, false, "no row, but the notice cannot be stored");
	assert.deepEqual(await everyDay(env, "2026-10-29", "2027-01-01", fetcher), ["disabled"]);
	await setTelemetryEnabled(env, true);
	assert.equal((await readTelemetryState(env)).decision, "on");
	assert.equal(await runTelemetryHeartbeat(env, at("2027-01-01"), fetcher), "sent");
	await setTelemetryEnabled(env, false);
	assert.equal((await readTelemetryState(env)).decision, "off");
	assert.equal(requests.length, 1);
});

test("KITE_TELEMETRY=0 and an empty KITE_TELEMETRY_URL override every decision", async (t) => {
	const { fetcher, requests } = recorder();
	const forcedEnv = { DB: await database(t), KITE_TELEMETRY_URL: COLLECTOR, KITE_TELEMETRY: "0" };
	const forced = await getTelemetryStatus(forcedEnv, SEEN);
	assert.deepEqual({ notice: forced.notice, forcedOff: forced.forcedOff }, { notice: false, forcedOff: true });
	await markTelemetryNotice(forcedEnv, "shown", SEEN);
	assert.equal((await readTelemetryState(forcedEnv)).startDay, null, "the clock never starts while forced off");

	// Told before KITE_TELEMETRY=0 was set: the start day passes without turning anything on.
	const told = { DB: await database(t), KITE_TELEMETRY_URL: COLLECTOR };
	await markTelemetryNotice(told, "shown", SEEN);
	const toldForced = { ...told, KITE_TELEMETRY: "off" };
	assert.equal((await getTelemetryStatus(toldForced, at(START_DAY))).startDay, null);
	assert.deepEqual(await everyDay(toldForced, START_DAY, "2026-12-31", fetcher), ["forced_off"]);
	assert.equal((await readTelemetryState(told)).decision, null);
	await setTelemetryEnabled(told, true);
	assert.equal(await runTelemetryHeartbeat(toldForced, at("2026-12-31"), fetcher), "forced_off");

	const empty = { DB: await database(t), KITE_TELEMETRY_URL: "" };
	assert.equal((await getTelemetryStatus(empty, SEEN)).notice, false, "nothing would be sent: no notice");
	await markTelemetryNotice(empty, "shown", SEEN);
	assert.equal((await readTelemetryState(empty)).startDay, null);
	await recordSetupTelemetryChoice(empty, true, SEEN);
	assert.deepEqual(await everyDay(empty, "2026-10-29", "2026-12-01", fetcher), ["no_endpoint"]);
	assert.equal(requests.length, 0);
});
