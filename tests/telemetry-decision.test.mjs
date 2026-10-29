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
	DEFAULT_TELEMETRY_URL,
	setupTelemetryDecision,
	telemetryDayLabel,
	telemetryLocalStart,
	telemetryNoticeDue,
	telemetryEarlierStartDay,
	telemetryNoticeText,
	telemetryStartDay,
	telemetryStartDayOutcome,
} = await load("utils");
const {
	isDefaultCollector,
	setupUsageStatisticsChoice,
	telemetryPurposeClause,
	telemetryHideLabel,
	telemetryNoticeCopy,
	telemetryStartsLater,
	telemetrySwitchOn,
	usageStatisticsSetupHint,
} = await load("notice");
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
/** The notice is first seen at 15:30 UTC on 28 October; the first 02:00 UTC run after that is on 29 October. */
const SEEN = new Date("2026-10-28T15:30:00Z");
const START_DAY = "2026-10-29";
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

test("the start day is the UTC day of the first 02:00 UTC run more than an hour after the notice was first seen", () => {
	assert.equal(telemetryStartDay(SEEN), START_DAY);
	assert.equal(telemetryStartDay(new Date("2026-10-28T00:00:00Z")), "2026-10-28", "tonight's run, still ahead");
	assert.equal(telemetryStartDay(new Date("2026-10-28T00:59:59.999Z")), "2026-10-28", "just over an hour left");
	assert.equal(telemetryStartDay(new Date("2026-10-28T01:00:00Z")), START_DAY, "an hour or less left: tomorrow's run");
	assert.equal(telemetryStartDay(new Date("2026-10-28T01:59:59Z")), START_DAY, "never a second before a run");
	assert.equal(telemetryStartDay(new Date("2026-10-28T02:00:00Z")), START_DAY, "the run of that moment may have gone");
	assert.equal(telemetryStartDay(new Date("2026-10-28T23:59:59Z")), START_DAY);
	// Across midnight UTC, month and year (23:00 UTC is the last moment to still leave an hour before 02:00 tomorrow).
	assert.equal(telemetryStartDay(new Date("2026-10-31T22:59:59Z")), "2026-11-01");
	assert.equal(telemetryStartDay(new Date("2026-10-31T23:59:59Z")), "2026-11-01");
	assert.equal(telemetryStartDay(new Date("2026-12-31T23:59:59Z")), "2027-01-01");
	assert.equal(telemetryDayLabel(START_DAY), "29 October 2026");
	assert.equal(
		telemetryNoticeText(START_DAY),
		"Kite will start sending usage statistics from 02:00 UTC on 29 October 2026 unless you turn them off.",
	);
});

test("the start moment in the owner's time zone, and nothing extra when it reads the same", () => {
	assert.equal(telemetryLocalStart(START_DAY, "UTC"), null);
	assert.equal(telemetryLocalStart(START_DAY, "Not/AZone"), null);
	const clean = (value) => value.replace(" at ", ", ");
	assert.equal(clean(telemetryLocalStart(START_DAY, "Europe/Amsterdam")), "29 October 2026, 03:00");
	assert.equal(clean(telemetryLocalStart(START_DAY, "Asia/Kolkata")), "29 October 2026, 07:30");
	// The date can differ from the UTC one: 02:00 UTC is still the evening before in Los Angeles, the next day in Auckland.
	assert.equal(clean(telemetryLocalStart(START_DAY, "America/Los_Angeles")), "28 October 2026, 19:00");
	assert.equal(clean(telemetryLocalStart(START_DAY, "Pacific/Auckland")), "29 October 2026, 15:00");
});

test("the rules: only an undecided install starts, only from a start day it was told about", () => {
	const live = { forcedOff: false, endpoint: COLLECTOR };
	const outcome = (overrides, now, context = live) => telemetryStartDayOutcome(choice(overrides), now, context);
	const before = at(START_DAY, "01:59:59");
	assert.equal(outcome({}, at("2027-01-01")), "wait", "never told: never starts");
	assert.equal(outcome({ startDay: START_DAY }, at("2026-10-28", "23:00:00")), "wait");
	assert.equal(outcome({ startDay: START_DAY }, before), "wait", "the day alone is not enough: the 02:00 run is");
	assert.equal(outcome({ startDay: START_DAY }, at(START_DAY)), "start");
	assert.equal(outcome({ startDay: START_DAY }, at("2026-11-20")), "start", "a missed run starts at the next one");
	assert.equal(outcome({ startDay: START_DAY, noticeDismissed: true }, at(START_DAY)), "start");
	assert.equal(
		outcome({ decision: "off", startDay: START_DAY }, at("2030-01-01")),
		"wait",
		"an explicit off stays off",
	);
	assert.equal(outcome({ decision: "on", startDay: START_DAY }, at("2030-01-01")), "wait");
	// The run came while nothing could be sent: the date is dropped, never acted on later.
	assert.equal(
		outcome({ startDay: START_DAY }, at(START_DAY), { ...live, forcedOff: true }),
		"expire",
		"KITE_TELEMETRY",
	);
	assert.equal(outcome({ startDay: START_DAY }, at(START_DAY), { ...live, endpoint: null }), "expire", "no collector");
	assert.equal(outcome({ startDay: START_DAY }, before, { ...live, forcedOff: true }), "wait", "not yet");

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
	assert.equal(setupUsageStatisticsChoice({ forcedOff: false, endpoint: COLLECTOR }, false), false);
	assert.equal(setupUsageStatisticsChoice(undefined, true), true);
	assert.equal(setupUsageStatisticsChoice({ forcedOff: true, endpoint: COLLECTOR }, true), undefined);
	assert.equal(telemetryHideLabel(START_DAY), "Hide (statistics still start on 29 October 2026 UTC)");
	const project = telemetryNoticeCopy(DEFAULT_TELEMETRY_URL);
	assert.equal(
		project.detail,
		"Once a day, around 02:00 UTC, it would send the Kite project one small pseudonymous report, so it can see how many active installs there are, which versions, runtimes and modules they run, and roughly how many accounts and mailboxes they have and use. It holds rough counts only: ranges, never exact numbers, and no names, email addresses, domains or message content. The collector does not store IP addresses. Nothing has been sent yet. Keep on starts with the next daily report; Turn off means nothing is ever sent.",
	);
	assert.equal(project.detail.match(/the Kite project/gi).length, 1, "the project is named once");
	// Another collector (KITE_TELEMETRY_URL): the copy names no operator and claims nothing about its logs.
	const custom = telemetryNoticeCopy(COLLECTOR);
	assert.doesNotMatch(custom.detail, /Kite project|IP address/);
	assert.equal(isDefaultCollector(null), false);
	assert.equal(telemetryPurposeClause(COLLECTOR), "to the collector this deployment is set up to use");
	assert.match(telemetryPurposeClause(DEFAULT_TELEMETRY_URL), /^so the Kite project can see how many active installs/);
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

test("an existing install is told first and sends nothing until the first 02:00 UTC run after that", async (t) => {
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
	assert.equal(await runTelemetryHeartbeat(env, at("2026-10-28"), fetcher), "disabled", "the run before it was seen");

	await markTelemetryNotice(env, "shown", SEEN);
	const shown = await getTelemetryStatus(env, SEEN);
	assert.equal(shown.startDay, START_DAY);
	assert.equal(shown.notice, true, "still shown until chosen or dismissed");
	await markTelemetryNotice(env, "shown", at("2026-10-28", "20:00:00"));
	assert.equal((await readTelemetryState(env)).startDay, START_DAY, "seeing it again never moves the day");
	assert.equal(await runTelemetryHeartbeat(env, at("2026-10-28", "20:00:00"), fetcher), "disabled");
	assert.equal(requests.length, 0, "nothing before the run");
	assert.equal((await readTelemetryState(env)).installId, null, "no id before the run");

	assert.equal(await runTelemetryHeartbeat(env, at(START_DAY), fetcher), "sent");
	const after = await readTelemetryState(env);
	assert.equal(after.decision, "on");
	assert.match(after.installId, UUID);
	assert.equal(requests[0].body.install_id, after.installId);
	assert.equal((await getTelemetryStatus(env, at(START_DAY))).notice, false);
});

test("a notice first seen over an hour before tonight's 02:00 UTC run starts with that run, not before it", async (t) => {
	const env = { DB: await database(t), KITE_TELEMETRY_URL: COLLECTOR };
	const { requests, fetcher } = recorder();
	await markTelemetryNotice(env, "shown", at("2026-10-28", "00:59:00"));
	assert.equal((await readTelemetryState(env)).startDay, "2026-10-28");
	// The owner has an hour: reading the status then does not turn anything on.
	const status = await getTelemetryStatus(env, at("2026-10-28", "01:59:00"));
	assert.deepEqual(
		{ notice: status.notice, decision: status.decision, enabled: status.enabled },
		{ notice: true, decision: null, enabled: false },
	);
	assert.equal(requests.length, 0);
	assert.equal(await runTelemetryHeartbeat(env, at("2026-10-28"), fetcher), "sent");

	// Seen with an hour or less to go (01:00, 01:59) or later: the next day's run, never a second before it.
	for (const time of ["01:00:00", "01:59:59", "02:00:00"]) {
		const later = { DB: await database(t), KITE_TELEMETRY_URL: COLLECTOR };
		await markTelemetryNotice(later, "shown", at("2026-10-28", time));
		assert.equal((await readTelemetryState(later)).startDay, "2026-10-29", time);
		assert.equal(await runTelemetryHeartbeat(later, at("2026-10-28", "02:00:30"), fetcher), "disabled", time);
		assert.equal(await runTelemetryHeartbeat(later, at("2026-10-29"), fetcher), "sent", time);
	}
});

/** An undecided install told under the earlier 14-day rule: 12 November, as the notice named it on 28 October. */
const LEGACY_DAY = "2026-11-12";

function insertLegacyNotice(sqlite, { dismissed = 0, startDay = LEGACY_DAY } = {}) {
	sqlite.db
		.prepare(
			"INSERT INTO telemetry_state (id, enabled, start_day, notice_dismissed, updated_at) VALUES ('default', 0, ?, ?, 1)",
		)
		.run(startDay, dismissed);
}

test("a later start day announced under the 14-day rule moves to the current rule, once, and only earlier", async (t) => {
	const sqlite = await database(t);
	const env = { DB: sqlite, KITE_TELEMETRY_URL: COLLECTOR };
	const { requests, fetcher } = recorder();
	insertLegacyNotice(sqlite);
	// The release runs at 15:30 UTC on 28 October; the status read moves the date to the next 02:00 UTC run.
	const status = await getTelemetryStatus(env, SEEN);
	assert.equal(status.startDay, START_DAY);
	assert.deepEqual(
		{ decision: status.decision, enabled: status.enabled, installId: status.installId, notice: status.notice },
		{ decision: null, enabled: false, installId: null, notice: true },
		"moving the date turns nothing on",
	);
	// Idempotent: later reads and a later markTelemetryNotice leave the date where it is.
	await getTelemetryStatus(env, at("2026-10-28", "20:00:00"));
	await markTelemetryNotice(env, "shown", at("2026-10-28", "21:00:00"));
	assert.equal((await readTelemetryState(env)).startDay, START_DAY);
	assert.equal(await runTelemetryHeartbeat(env, at("2026-10-28", "23:00:00"), fetcher), "disabled");
	assert.equal(requests.length, 0, "never before the first run at least an hour after the release");
	assert.equal(await runTelemetryHeartbeat(env, at(START_DAY), fetcher), "sent");
	assert.equal((await readTelemetryState(env)).decision, "on");
});

test("the recompute runs at the next cron when nobody read the status, and keeps the hour of lead", async (t) => {
	const { requests, fetcher } = recorder();
	// The release is running at 01:30 UTC: tonight's run is under an hour away, so the first run is tomorrow's.
	const early = { DB: await database(t), KITE_TELEMETRY_URL: COLLECTOR };
	insertLegacyNotice(early.DB);
	assert.equal(await runTelemetryHeartbeat(early, at("2026-10-29", "01:30:00"), fetcher), "disabled");
	assert.equal((await readTelemetryState(early)).startDay, "2026-10-30");
	assert.equal(requests.length, 0);
	// The cron of 02:00 itself is the first run that finds the release: statistics start with tomorrow's run.
	const cron = { DB: await database(t), KITE_TELEMETRY_URL: COLLECTOR };
	insertLegacyNotice(cron.DB);
	assert.equal(await runTelemetryHeartbeat(cron, at("2026-10-29"), fetcher), "disabled");
	assert.equal((await readTelemetryState(cron)).startDay, "2026-10-30");
	assert.equal(await runTelemetryHeartbeat(cron, at("2026-10-30"), fetcher), "sent");
	// Running just over an hour before tonight's run: that run starts it.
	const ahead = { DB: await database(t), KITE_TELEMETRY_URL: COLLECTOR };
	insertLegacyNotice(ahead.DB);
	assert.equal(await applyTelemetryStartDay(ahead, at("2026-10-29", "00:59:00")), null);
	assert.equal((await readTelemetryState(ahead)).startDay, "2026-10-29");
	assert.equal(await runTelemetryHeartbeat(ahead, at("2026-10-29"), fetcher), "sent");
});

test("the recompute never moves a date later, never touches a decision and never invents a date", async (t) => {
	const { requests, fetcher } = recorder();
	// A date the current rule gave stays, and so does one that has already come (it starts, it is not moved).
	for (const startDay of [START_DAY, "2026-01-01"]) {
		const sqlite = await database(t);
		const env = { DB: sqlite, KITE_TELEMETRY_URL: COLLECTOR };
		insertLegacyNotice(sqlite, { startDay });
		await applyTelemetryStartDay(env, SEEN);
		assert.equal((await readTelemetryState(env)).startDay, startDay, startDay);
	}
	// A notice the owner hid promised the old date: it moves too, and the notice comes back naming the new one.
	const dismissed = await database(t);
	insertLegacyNotice(dismissed, { dismissed: 1 });
	const dismissedEnv = { DB: dismissed, KITE_TELEMETRY_URL: COLLECTOR };
	const dismissedState = await getTelemetryStatus(dismissedEnv, SEEN);
	assert.deepEqual(
		{ startDay: dismissedState.startDay, notice: dismissedState.notice, decision: dismissedState.decision },
		{ startDay: START_DAY, notice: true, decision: null },
	);
	assert.equal((await readTelemetryState(dismissedEnv)).noticeDismissed, false);
	// Hiding it again keeps the new date, and nothing moves it a second time.
	await markTelemetryNotice(dismissedEnv, "dismissed", at("2026-10-28", "16:00:00"));
	await getTelemetryStatus(dismissedEnv, at("2026-10-28", "17:00:00"));
	assert.deepEqual(
		{
			startDay: (await readTelemetryState(dismissedEnv)).startDay,
			hidden: (await readTelemetryState(dismissedEnv)).noticeDismissed,
		},
		{ startDay: START_DAY, hidden: true },
	);
	// A hidden notice whose date is already in line stays hidden.
	const inLine = await database(t);
	insertLegacyNotice(inLine, { dismissed: 1, startDay: START_DAY });
	await getTelemetryStatus({ DB: inLine, KITE_TELEMETRY_URL: COLLECTOR }, SEEN);
	assert.equal((await readTelemetryState({ DB: inLine })).noticeDismissed, true);

	// Decided installs keep their decision and never get a date.
	for (const decision of ["on", "off"]) {
		const sqlite = await database(t);
		const env = { DB: sqlite, KITE_TELEMETRY_URL: COLLECTOR };
		sqlite.db
			.prepare(
				"INSERT INTO telemetry_state (id, enabled, install_id, decision, start_day, updated_at) VALUES ('default', ?, ?, ?, ?, 1)",
			)
			.run(
				decision === "on" ? 1 : 0,
				decision === "on" ? "3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e" : null,
				decision,
				LEGACY_DAY,
			);
		await getTelemetryStatus(env, SEEN);
		await applyTelemetryStartDay(env, SEEN);
		const state = await readTelemetryState(env);
		assert.deepEqual({ decision: state.decision, startDay: state.startDay }, { decision, startDay: LEGACY_DAY });
	}
	// Never told (no start day): nothing is invented, so nothing starts.
	const unseen = { DB: await database(t), KITE_TELEMETRY_URL: COLLECTOR };
	assert.equal((await getTelemetryStatus(unseen, SEEN)).startDay, null);
	assert.equal((await readTelemetryState(unseen)).startDay, null);
	assert.deepEqual(await everyDay(unseen, "2026-10-29", "2026-12-31", fetcher), ["disabled"]);
	assert.equal(requests.length, 0);
});

test("the earlier start day rule is pure: only an undecided, told install with a later date moves", () => {
	const startDayOf = (input, now = SEEN) => telemetryEarlierStartDay(input, now)?.startDay ?? null;
	const told = choice({ startDay: LEGACY_DAY });
	assert.deepEqual(telemetryEarlierStartDay(told, SEEN), {
		decision: null,
		startDay: START_DAY,
		noticeDismissed: false,
	});
	assert.equal(startDayOf(choice({ startDay: START_DAY })), null, "same day");
	assert.equal(startDayOf(choice({ startDay: "2026-10-28" })), null, "never later");
	assert.equal(startDayOf(choice()), null, "never told");
	assert.equal(startDayOf(choice({ startDay: LEGACY_DAY, decision: "off" })), null);
	assert.equal(startDayOf(choice({ startDay: LEGACY_DAY, decision: "on" })), null);
	// A hidden notice comes back with the new date.
	assert.deepEqual(telemetryEarlierStartDay(choice({ startDay: LEGACY_DAY, noticeDismissed: true }), SEEN), {
		decision: null,
		startDay: START_DAY,
		noticeDismissed: false,
	});
	// Running it again with the result changes nothing, at any later moment.
	const moved = choice({ startDay: START_DAY });
	for (const time of ["2026-10-28T16:00:00Z", "2026-10-29T01:00:00Z", "2026-11-30T12:00:00Z"])
		assert.equal(startDayOf(moved, new Date(time)), null, time);
	assert.equal(startDayOf(choice({ startDay: telemetryStartDay(SEEN) }), new Date("2027-01-01T00:00:00Z")), null);
});

test("where nothing can be sent the recompute moves no date and brings no notice back", async (t) => {
	for (const env of [
		{ KITE_TELEMETRY: "0", KITE_TELEMETRY_URL: COLLECTOR },
		{ KITE_TELEMETRY_URL: "" },
		{ KITE_TELEMETRY_URL: "https://collector.invalid/v1/heartbeat" },
	]) {
		const sqlite = await database(t);
		insertLegacyNotice(sqlite, { dismissed: 1 });
		await getTelemetryStatus({ DB: sqlite, ...env }, SEEN);
		const state = await readTelemetryState({ DB: sqlite });
		assert.deepEqual(
			{ startDay: state.startDay, hidden: state.noticeDismissed },
			{ startDay: LEGACY_DAY, hidden: true },
			JSON.stringify(env),
		);
	}
});

test("dismissing the notice keeps its start day; Keep on starts at once; Turn off is final", async (t) => {
	const { fetcher, requests } = recorder();
	const dismissed = { DB: await database(t), KITE_TELEMETRY_URL: COLLECTOR };
	await markTelemetryNotice(dismissed, "shown", SEEN);
	await markTelemetryNotice(dismissed, "dismissed", new Date("2026-10-28T16:00:00Z"));
	const status = await getTelemetryStatus(dismissed, SEEN);
	assert.deepEqual({ notice: status.notice, startDay: status.startDay }, { notice: false, startDay: START_DAY });
	assert.equal(await runTelemetryHeartbeat(dismissed, at("2026-10-28", "20:00:00"), fetcher), "disabled");
	assert.equal(await runTelemetryHeartbeat(dismissed, at(START_DAY), fetcher), "sent");

	const keptOn = { DB: await database(t), KITE_TELEMETRY_URL: COLLECTOR };
	await markTelemetryNotice(keptOn, "shown", SEEN);
	await setTelemetryEnabled(keptOn, true);
	assert.equal((await getTelemetryStatus(keptOn, SEEN)).notice, false);
	assert.equal(
		await runTelemetryHeartbeat(keptOn, at("2026-10-29"), fetcher),
		"sent",
		"Keep on: the next daily report",
	);

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
	assert.equal(await applyTelemetryStartDay(turnedOff, at("2027-06-01")), null);
	await markTelemetryNotice(turnedOff, "shown", at("2027-06-01"));
	assert.equal((await getTelemetryStatus(turnedOff, at("2027-06-01"))).decision, "off", "never re-enabled");
	assert.equal(requests.length, sent);
});

test("an owner who turned statistics off before the upgrade stays off; one who turned them on stays on", async (t) => {
	const scratch = makeBundleDirectory("kite-telemetry-decision-migrations-");
	t.after(() => rmSync(scratch, { recursive: true, force: true }));
	const before0075 = copyMigrationsBefore(scratch, 75);
	const { fetcher, requests } = recorder();
	for (const [enabled, decision] of [
		[0, "off"],
		[1, "on"],
	]) {
		const sqlite = await database(t, before0075);
		const env = { DB: sqlite, KITE_TELEMETRY_URL: COLLECTOR };
		sqlite.db
			.prepare("INSERT INTO telemetry_state (id, enabled, install_id, updated_at) VALUES ('default', ?, ?, 1)")
			.run(enabled, enabled ? "3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e" : null);
		// Before 0075: a row is the owner's choice, the notice cannot be stored and is never shown.
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

test("before migration 0075 the switch still works and nothing starts by itself", async (t) => {
	const scratch = makeBundleDirectory("kite-telemetry-decision-pre-0075-");
	t.after(() => rmSync(scratch, { recursive: true, force: true }));
	const sqlite = await database(t, copyMigrationsBefore(scratch, 75));
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

	// Told (and the notice hidden) before KITE_TELEMETRY=0 was set: the start day comes without turning anything on,
	// no id is made, and the stale date and the dismissal are cleared, so the notice comes back with a new date.
	const told = { DB: await database(t), KITE_TELEMETRY_URL: COLLECTOR };
	await markTelemetryNotice(told, "shown", SEEN);
	await markTelemetryNotice(told, "dismissed", SEEN);
	const toldForced = { ...told, KITE_TELEMETRY: "off" };
	assert.equal(await runTelemetryHeartbeat(toldForced, at(START_DAY), fetcher), "forced_off");
	assert.deepEqual(
		(({ decision, enabled, installId, startDay, noticeDismissed }) => ({
			decision,
			enabled,
			installId,
			startDay,
			noticeDismissed,
		}))(await readTelemetryState(told)),
		{ decision: null, enabled: false, installId: null, startDay: null, noticeDismissed: false },
	);
	assert.deepEqual(await everyDay(toldForced, START_DAY, "2026-12-31", fetcher), ["forced_off"]);
	const back = await getTelemetryStatus(told, at("2026-12-31", "09:00:00"));
	assert.deepEqual(
		{ notice: back.notice, startDay: back.startDay, enabled: back.enabled },
		{ notice: true, startDay: null, enabled: false },
	);
	await markTelemetryNotice(told, "shown", at("2026-12-31", "09:00:00"));
	assert.equal((await readTelemetryState(told)).startDay, "2027-01-01", "a new date, the next run after it was shown");
	assert.equal(
		await runTelemetryHeartbeat(told, at("2026-12-31", "12:00:00"), fetcher),
		"disabled",
		"not before the new date",
	);
	await setTelemetryEnabled(told, true);
	assert.equal(await runTelemetryHeartbeat(toldForced, at("2026-12-31"), fetcher), "forced_off");

	const empty = { DB: await database(t), KITE_TELEMETRY_URL: "" };
	assert.equal((await getTelemetryStatus(empty, SEEN)).notice, false, "nothing would be sent: no notice");
	await markTelemetryNotice(empty, "shown", SEEN);
	assert.equal((await readTelemetryState(empty)).startDay, null);
	// A date set while an address was usable, reached after it was emptied: cleared, nothing turns on.
	const emptied = { DB: await database(t), KITE_TELEMETRY_URL: COLLECTOR };
	await markTelemetryNotice(emptied, "shown", SEEN);
	const emptiedNow = { ...emptied, KITE_TELEMETRY_URL: "" };
	assert.equal(await applyTelemetryStartDay(emptiedNow, at(START_DAY)), "expired");
	assert.equal(await runTelemetryHeartbeat(emptiedNow, at(START_DAY), fetcher), "no_endpoint");
	const cleared = await readTelemetryState(emptied);
	assert.deepEqual(
		{ decision: cleared.decision, installId: cleared.installId, startDay: cleared.startDay },
		{ decision: null, installId: null, startDay: null },
	);
	await recordSetupTelemetryChoice(empty, true, SEEN);
	assert.deepEqual(await everyDay(empty, "2026-10-29", "2026-12-01", fetcher), ["no_endpoint"]);
	assert.equal(requests.length, 0);
});

test("the date is the same UTC day whatever the server's time zone", () => {
	const previous = process.env.TZ;
	process.env.TZ = "America/Los_Angeles";
	try {
		// 28 October 23:30 UTC is still 28 October in Los Angeles; 29 October 01:30 UTC is 28 October 18:30 there.
		assert.equal(new Date("2026-10-29T01:30:00Z").getDate(), 28, "the zone is in effect");
		assert.equal(telemetryStartDay(new Date("2026-10-28T23:30:00Z")), START_DAY);
		assert.equal(
			telemetryStartDay(new Date("2026-10-29T00:30:00Z")),
			"2026-10-29",
			"still ahead, with an hour to spare",
		);
		assert.equal(telemetryStartDay(new Date("2026-10-29T01:30:00Z")), "2026-10-30", "less than an hour left");
		assert.equal(telemetryDayLabel(START_DAY), "29 October 2026");
		assert.equal(
			telemetryNoticeText(START_DAY),
			"Kite will start sending usage statistics from 02:00 UTC on 29 October 2026 unless you turn them off.",
		);
		assert.equal(telemetryHideLabel(START_DAY), "Hide (statistics still start on 29 October 2026 UTC)");
	} finally {
		if (previous === undefined) delete process.env.TZ;
		else process.env.TZ = previous;
	}
});
