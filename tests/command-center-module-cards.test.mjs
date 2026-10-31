import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

// The pure parts of the command center's module cards: Calendar's Today card and Money Watch's renewals card.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-command-center-module-cards-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: [
			'export { durationText, todayLines, TODAY_MAX_LINES } from "./src/components/modules/calendar/today-card-utils.ts";',
			'export { renewalLines, RENEWALS_MAX_LINES } from "./src/components/modules/finance/renewals-card-utils.ts";',
		].join("\n"),
		resolveDir: root,
		sourcefile: "module-cards-entry.ts",
	},
	outfile: join(bundleDirectory, "cards.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	absWorkingDir: root,
	logLevel: "silent",
});
const { durationText, todayLines, TODAY_MAX_LINES, renewalLines, RENEWALS_MAX_LINES } = await import(
	pathToFileURL(join(bundleDirectory, "cards.mjs")).href
);

const ZONE = "Europe/Amsterdam";
const NOW = new Date("2026-10-31T09:15:00Z");
// The Amsterdam day of NOW ends at midnight local time, 23:00 UTC in winter time.
const DAY_END = new Date("2026-10-31T23:00:00Z");
const time = (iso) =>
	new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: ZONE }).format(new Date(iso));

function event(id, startsAt, endsAt, overrides = {}) {
	return {
		id,
		title: `Event ${id}`,
		description: "",
		startsAt,
		endsAt,
		location: "",
		attendees: "[]",
		color: "blue",
		repeat: "none",
		repeatDays: "[]",
		repeatAnchorDay: null,
		repeatUntil: null,
		excludedOccurrences: "[]",
		...overrides,
	};
}

test("an event's length reads as minutes, hours, or all day", () => {
	assert.equal(durationText("2026-10-31T10:00:00Z", "2026-10-31T10:30:00Z"), "30 min");
	assert.equal(durationText("2026-10-31T10:00:00Z", "2026-10-31T11:00:00Z"), "1 h");
	assert.equal(durationText("2026-10-31T10:00:00Z", "2026-10-31T11:30:00Z"), "1 h 30 min");
	assert.equal(durationText("2026-10-31T00:00:00Z", "2026-11-01T00:00:00Z"), "All day");
	assert.equal(durationText("2026-10-31T10:00:00Z", "2026-10-31T09:00:00Z"), "0 min");
});

test("today lists what is not over yet, earliest first, with Now for what is under way", () => {
	const { lines, more, empty } = todayLines(
		[
			event("later", "2026-10-31T15:00:00Z", "2026-10-31T16:00:00Z", { location: " Café Noord " }),
			event("over", "2026-10-31T07:00:00Z", "2026-10-31T08:00:00Z"),
			event("running", "2026-10-31T09:00:00Z", "2026-10-31T09:30:00Z"),
			event("tomorrow", "2026-10-31T23:00:00Z", "2026-10-31T23:30:00Z"),
			event("soon", "2026-10-31T12:30:00Z", "2026-10-31T13:00:00Z"),
		],
		{ now: NOW, dayEnd: DAY_END, timeZone: ZONE },
	);
	assert.deepEqual(
		lines.map((line) => [line.id, line.when, line.what, line.meta]),
		[
			["running", "Now", "Event running", "30 min"],
			["soon", time("2026-10-31T12:30:00Z"), "Event soon", "30 min"],
			["later", time("2026-10-31T15:00:00Z"), "Event later", "Café Noord"],
		],
	);
	assert.equal(more, 0);
	assert.equal(empty, "Nothing else today");
});

test("each line opens the event on its day in the user's time zone", () => {
	const late = new Date("2026-10-31T22:30:00Z");
	const { lines } = todayLines([event("evt_1@1793486400000", "2026-10-31T22:45:00Z", "2026-10-31T23:15:00Z")], {
		now: late,
		dayEnd: DAY_END,
		timeZone: ZONE,
	});
	assert.equal(lines[0].href, "/calendar?date=2026-10-31&event=evt_1%401793486400000");
	const { lines: utc } = todayLines([event("e", "2026-10-31T23:45:00Z", "2026-11-01T00:15:00Z")], {
		now: late,
		dayEnd: new Date("2026-11-01T00:00:00Z"),
		timeZone: "UTC",
	});
	assert.equal(utc[0].href, "/calendar?date=2026-10-31&event=e");
});

test("today shows a few events and counts the rest", () => {
	const many = Array.from({ length: TODAY_MAX_LINES + 2 }, (_, index) =>
		event(`e${index}`, `2026-10-31T1${index}:00:00Z`, `2026-10-31T1${index}:30:00Z`),
	);
	const { lines, more } = todayLines(many, { now: NOW, dayEnd: DAY_END, timeZone: ZONE });
	assert.equal(lines.length, TODAY_MAX_LINES);
	assert.equal(more, 2);
	assert.deepEqual(
		todayLines(many, { now: NOW, dayEnd: DAY_END, timeZone: ZONE, max: 2 }).lines.map((line) => line.id),
		["e0", "e1"],
	);
});

test("an empty day says Nothing today, a finished one Nothing else today", () => {
	assert.deepEqual(todayLines([], { now: NOW, dayEnd: DAY_END, timeZone: ZONE }), {
		lines: [],
		more: 0,
		empty: "Nothing today",
	});
	const done = todayLines([event("a", "2026-10-31T07:00:00Z", "2026-10-31T08:00:00Z")], {
		now: NOW,
		dayEnd: DAY_END,
		timeZone: ZONE,
	});
	assert.deepEqual(done.lines, []);
	assert.equal(done.empty, "Nothing else today");
});

const TODAY = "2026-10-15";

function subscription(id, overrides = {}) {
	return {
		id,
		vendor: `Vendor ${id}`,
		plan: null,
		amount: { minor: 1799, currency: "USD" },
		cycle: "monthly",
		status: "active",
		nextRenewalOn: null,
		renewalEstimated: false,
		trialEndsOn: null,
		urgent: false,
		reminderDays: 3,
		calendarReminder: false,
		cancelUrl: null,
		previousAmountMinor: null,
		priceChangedAt: null,
		lastMessageId: null,
		sourceMessageId: null,
		mailboxId: null,
		...overrides,
	};
}

test("this week's renewals come after failed payments, earliest first, and leave the rest out", () => {
	const { lines, more } = renewalLines(
		[
			subscription("later", { nextRenewalOn: "2026-10-18" }),
			subscription("next-week", { nextRenewalOn: "2026-10-22" }),
			subscription("week-end", { nextRenewalOn: "2026-10-21" }),
			subscription("passed", { nextRenewalOn: "2026-10-14" }),
			subscription("cancelled", { status: "cancelled", nextRenewalOn: "2026-10-16" }),
			subscription("undated"),
			subscription("failed", { urgent: true, nextRenewalOn: "2026-11-01" }),
			subscription("today", { nextRenewalOn: TODAY, vendor: "Acmeflix" }),
			subscription("trial", { status: "trial", trialEndsOn: "2026-10-16", nextRenewalOn: "2026-12-01" }),
		],
		TODAY,
		"en-US",
	);
	assert.deepEqual(
		lines.map((line) => [line.id, line.when, line.meta, line.urgent]),
		[
			["failed", "Failed", "Payment failed", true],
			["today", "Today", "$17.99/month", false],
			["trial", "Tomorrow", "Trial ends", false],
			["later", "18 Oct", "$17.99/month", false],
		],
	);
	assert.equal(lines[1].what, "Acmeflix");
	assert.equal(more, 1, "week-end, the seventh day, is counted but not shown");
	assert.equal(lines[0].href, "/finance?subscription=failed");
});

test("renewals show a few lines, count the rest and link each subscription", () => {
	const items = Array.from({ length: RENEWALS_MAX_LINES + 3 }, (_, index) =>
		subscription(`fsub ${index}`, { nextRenewalOn: TODAY, vendor: `V${index}` }),
	);
	const { lines, more } = renewalLines(items, TODAY, "en-US");
	assert.equal(lines.length, RENEWALS_MAX_LINES);
	assert.equal(more, 3);
	assert.deepEqual(
		lines.map((line) => line.what),
		["V0", "V1", "V2", "V3"],
	);
	assert.equal(lines[0].href, "/finance?subscription=fsub%200");
	assert.deepEqual(renewalLines([], TODAY, "en-US"), { lines: [], more: 0 });
	assert.deepEqual(
		renewalLines([subscription("free", { amount: null, nextRenewalOn: TODAY })], TODAY, "en-US").lines[0].meta,
		"No price",
	);
});
