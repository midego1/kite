import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-calendar-feed-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		feed: join(root, "src/lib/calendar/feed-utils.ts"),
		ics: join(root, "src/lib/calendar/ics-utils.ts"),
		token: join(root, "src/lib/calendar/feed-token-utils.ts"),
		vtimezone: join(root, "src/lib/calendar/vtimezone-utils.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { buildCalendarFeed } = await load("feed");
const { escapeIcsText, foldIcsLine, formatIcsLocal } = await load("ics");
const { buildVtimezone } = await load("vtimezone");
const { calendarFeedPath, feedTokenPrefix, generateFeedToken, hashFeedToken, parseFeedTokenSegment } =
	await load("token");

const base = {
	id: "evt_1",
	title: "Standup, daily",
	description: "",
	location: "",
	repeat: "none",
	repeatDays: "[]",
	repeatAnchorDay: null,
	repeatUntil: null,
	excludedOccurrences: "[]",
	timeZone: null,
	status: "confirmed",
	startsAt: new Date("2026-11-02T17:00:00Z"),
	endsAt: new Date("2026-11-02T17:30:00Z"),
};
const options = { name: "Kite calendar", timeZone: "UTC", now: new Date("2026-11-01T00:00:00Z") };
const feed = (events, extra = {}) => buildCalendarFeed(events, { ...options, ...extra });
const unfold = (ics) => ics.replace(/\r\n /g, "");
const lines = (ics) => unfold(ics).split("\r\n");
/** The content lines of the one VEVENT in the feed. */
const eventLines = (ics) => {
	const all = lines(ics);
	return all.slice(all.indexOf("BEGIN:VEVENT"), all.indexOf("END:VEVENT") + 1);
};

test("the calendar is a PUBLISH document that ends with CRLF", () => {
	const ics = feed([]);
	const all = lines(ics);
	assert.deepEqual(all.slice(0, 5), [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Kite//Calendar feed//EN",
		"CALSCALE:GREGORIAN",
		"METHOD:PUBLISH",
	]);
	assert.ok(all.includes("X-WR-CALNAME:Kite calendar"));
	assert.ok(all.includes("X-WR-TIMEZONE:UTC"));
	assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
	assert.doesNotMatch(ics.replace(/\r\n/g, ""), /[\r\n]/, "every line ends with CRLF, never a bare LF or CR");
});

test("a one-off event is written in UTC with escaped text", () => {
	const ics = feed([{ ...base, description: "Line one\nLine two; with a \\ backslash", location: "Room 1, floor 2" }]);
	const event = eventLines(ics);
	assert.ok(event.includes("UID:evt_1@kite"));
	assert.ok(event.includes("DTSTAMP:20261101T000000Z"));
	assert.ok(event.includes("DTSTART:20261102T170000Z"));
	assert.ok(event.includes("DTEND:20261102T173000Z"));
	assert.ok(event.includes("SUMMARY:Standup\\, daily"));
	assert.ok(event.includes("DESCRIPTION:Line one\\nLine two\\; with a \\\\ backslash"));
	assert.ok(event.includes("LOCATION:Room 1\\, floor 2"));
	assert.ok(event.includes("STATUS:CONFIRMED"));
	assert.equal(event.filter((line) => line.startsWith("RRULE")).length, 0);
});

test("a one-off event stays in UTC even when it has a zone", () => {
	const event = eventLines(feed([{ ...base, timeZone: "Europe/Amsterdam" }], { timeZone: "Europe/Amsterdam" }));
	assert.ok(event.includes("DTSTART:20261102T170000Z"));
});

test("a tentative event says so", () => {
	assert.ok(eventLines(feed([{ ...base, status: "tentative" }])).includes("STATUS:TENTATIVE"));
});

test("a weekday series uses BYDAY, its zone, EXDATE and an inclusive UNTIL", () => {
	const event = eventLines(
		feed([
			{
				...base,
				repeat: "weekdays",
				repeatDays: "[1,3,5]",
				timeZone: "America/Los_Angeles",
				repeatUntil: new Date("2026-12-01T00:00:00Z"),
				excludedOccurrences: `[${Date.parse("2026-11-04T17:00:00Z")}]`,
			},
		]),
	);
	assert.ok(event.includes("DTSTART;TZID=America/Los_Angeles:20261102T090000"));
	assert.ok(event.includes("DTEND;TZID=America/Los_Angeles:20261102T093000"));
	// Kite stops before repeatUntil; UNTIL is the last instant still allowed.
	assert.ok(event.includes("RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20261130T235959Z"));
	assert.ok(event.includes("EXDATE;TZID=America/Los_Angeles:20261104T090000"));
});

test("a weekday series starting on a day it skips excludes that first day", () => {
	// 2026-11-03 is a Tuesday; Kite's own expansion leaves it out, iCalendar would count DTSTART.
	const startsAt = new Date("2026-11-03T09:00:00Z");
	const event = eventLines(
		feed([{ ...base, repeat: "weekdays", repeatDays: "[1,3]", startsAt, endsAt: new Date("2026-11-03T10:00:00Z") }]),
	);
	assert.ok(event.includes("RRULE:FREQ=WEEKLY;BYDAY=MO,WE"));
	assert.ok(event.includes("EXDATE:20261103T090000Z"));
});

test("a weekday series with no weekday has no occurrence and is left out", () => {
	assert.equal(lines(feed([{ ...base, repeat: "weekdays", repeatDays: "[]" }])).includes("BEGIN:VEVENT"), false);
});

test("daily and weekly series keep their wall-clock time in their zone across daylight saving", () => {
	const startsAt = new Date("2026-10-20T07:00:00Z"); // 09:00 in Amsterdam (CEST), before the 25 October change
	const event = { ...base, startsAt, endsAt: new Date("2026-10-20T08:00:00Z"), timeZone: "Europe/Amsterdam" };
	const weekly = eventLines(feed([{ ...event, repeat: "weekly" }]));
	assert.ok(weekly.includes("DTSTART;TZID=Europe/Amsterdam:20261020T090000"));
	assert.ok(weekly.includes("RRULE:FREQ=WEEKLY"));
	assert.ok(eventLines(feed([{ ...event, repeat: "daily" }])).includes("RRULE:FREQ=DAILY"));
});

test("a series without a stored zone uses the owner's, and an invalid zone falls back to it too", () => {
	const owner = { timeZone: "Europe/Amsterdam" };
	for (const timeZone of [null, "Not/AZone"]) {
		const event = eventLines(feed([{ ...base, repeat: "weekly", timeZone }], owner));
		assert.ok(event.includes("DTSTART;TZID=Europe/Amsterdam:20261102T180000"), String(timeZone));
	}
	assert.ok(lines(feed([], { timeZone: "Not/AZone" })).includes("X-WR-TIMEZONE:UTC"));
});

test("monthly series follow Kite's anchor day, moving to the last day of shorter months", () => {
	const monthly = (anchor) =>
		eventLines(feed([{ ...base, repeat: "monthly", repeatAnchorDay: anchor }])).find((line) =>
			line.startsWith("RRULE"),
		);
	assert.equal(monthly(15), "RRULE:FREQ=MONTHLY;BYMONTHDAY=15");
	assert.equal(monthly(28), "RRULE:FREQ=MONTHLY;BYMONTHDAY=28");
	assert.equal(monthly(30), "RRULE:FREQ=MONTHLY;BYMONTHDAY=28,29,30;BYSETPOS=-1");
	assert.equal(monthly(31), "RRULE:FREQ=MONTHLY;BYMONTHDAY=28,29,30,31;BYSETPOS=-1");
	// Without a stored anchor, the start's own day in the zone.
	assert.equal(monthly(null), "RRULE:FREQ=MONTHLY;BYMONTHDAY=2");
});

test("an all-day event is written as whole dates in its zone", () => {
	// Stored as local midnight to local midnight, the way an accepted all-day invitation is.
	const allDay = {
		...base,
		startsAt: new Date("2026-11-03T23:00:00Z"),
		endsAt: new Date("2026-11-05T23:00:00Z"),
		timeZone: "Europe/Amsterdam",
	};
	const event = eventLines(feed([allDay]));
	assert.ok(event.includes("DTSTART;VALUE=DATE:20261104"));
	assert.ok(event.includes("DTEND;VALUE=DATE:20261106"));
	// A recurring all-day event uses dates for UNTIL and EXDATE too.
	const series = eventLines(
		feed([
			{
				...allDay,
				endsAt: new Date("2026-11-04T23:00:00Z"),
				repeat: "weekly",
				repeatUntil: new Date("2026-12-01T23:00:00Z"),
				excludedOccurrences: `[${Date.parse("2026-11-10T23:00:00Z")}]`,
			},
		]),
	);
	// repeatUntil is local midnight starting 2 December, so 1 December is the last day.
	assert.ok(series.includes("RRULE:FREQ=WEEKLY;UNTIL=20261201"));
	assert.ok(series.includes("EXDATE;VALUE=DATE:20261111"));
	// A midnight in UTC is not all day for an owner in Amsterdam.
	const utcMidnight = { ...base, startsAt: new Date("2026-11-04T00:00:00Z"), endsAt: new Date("2026-11-05T00:00:00Z") };
	assert.ok(eventLines(feed([utcMidnight], { timeZone: "Europe/Amsterdam" })).includes("DTSTART:20261104T000000Z"));
	assert.ok(eventLines(feed([utcMidnight])).includes("DTSTART;VALUE=DATE:20261104"));
});

test("event text cannot start a new property line", () => {
	const hostile = "Lunch\rATTENDEE:mailto:evil@example.com\nX-ATTACK:1\r\nEND:VEVENT\u0000\u0007";
	const ics = feed([{ ...base, title: hostile, description: hostile, location: hostile }]);
	const all = ics.split("\r\n");
	for (const line of all) assert.doesNotMatch(line, /[\r\n\u0000-\u0008\u000b-\u001f]/);
	assert.equal(all.filter((line) => line.startsWith("ATTENDEE")).length, 0);
	assert.equal(all.filter((line) => line.startsWith("X-ATTACK")).length, 0);
	assert.equal(all.filter((line) => line === "END:VEVENT").length, 1);
	assert.equal(escapeIcsText("a\tb"), "a\tb", "a tab is valid TEXT");
});

test("long lines fold at 75 octets without splitting a character", () => {
	const line = `DESCRIPTION:${"é".repeat(100)}🙂${"x".repeat(80)}`;
	const folded = foldIcsLine(line);
	for (const part of folded.split("\r\n")) assert.ok(new TextEncoder().encode(part).length <= 75, part);
	assert.equal(folded.replace(/\r\n /g, ""), line);
	assert.equal(foldIcsLine("SUMMARY:short"), "SUMMARY:short");
	const ics = feed([{ ...base, description: "Ünïcödé ".repeat(40) }]);
	for (const part of ics.split("\r\n")) assert.ok(new TextEncoder().encode(part).length <= 75);
});

test("local times are the wall clock in the zone", () => {
	assert.equal(formatIcsLocal(new Date("2026-07-01T10:00:00Z"), "Europe/Amsterdam"), "20260701T120000");
	assert.equal(formatIcsLocal(new Date("2026-01-01T00:30:00Z"), "America/New_York"), "20251231T193000");
});

test("feed tokens are long, distinct from API keys and parsed strictly from the path", async () => {
	const token = generateFeedToken();
	assert.match(token, /^kcf_[0-9A-Za-z]{32}$/);
	assert.notEqual(generateFeedToken(), token);
	assert.equal(feedTokenPrefix(token), token.slice(0, 12));
	assert.equal(calendarFeedPath(token), `/api/public/calendar/feed/${token}.ics`);
	assert.equal(parseFeedTokenSegment(`${token}.ics`), token);
	assert.equal(parseFeedTokenSegment(token), token);
	for (const bad of ["", "kcf_short.ics", `${token}x.ics`, `ep_${token.slice(4)}`, `${token}.ics.ics`, "../kcf_"])
		assert.equal(parseFeedTokenSegment(bad), null, bad);
	const hash = await hashFeedToken(token);
	assert.match(hash, /^[0-9a-f]{64}$/);
	assert.equal(await hashFeedToken(token), hash);
	assert.notEqual(await hashFeedToken(generateFeedToken()), hash);
});

test("a VTIMEZONE lists every offset change with the local time it happens at", () => {
	const start = Date.UTC(2026, 0, 1);
	const end = Date.UTC(2027, 0, 1);
	assert.deepEqual(buildVtimezone("Europe/Amsterdam", start, end), [
		"BEGIN:VTIMEZONE",
		"TZID:Europe/Amsterdam",
		"BEGIN:STANDARD",
		"DTSTART:20260101T010000",
		"TZOFFSETFROM:+0100",
		"TZOFFSETTO:+0100",
		"END:STANDARD",
		"BEGIN:DAYLIGHT",
		"DTSTART:20260329T020000",
		"TZOFFSETFROM:+0100",
		"TZOFFSETTO:+0200",
		"END:DAYLIGHT",
		"BEGIN:STANDARD",
		"DTSTART:20261025T030000",
		"TZOFFSETFROM:+0200",
		"TZOFFSETTO:+0100",
		"END:STANDARD",
		"END:VTIMEZONE",
	]);
	// A zone without daylight saving has one STANDARD observance; negative and half-hour offsets are written in full.
	const tokyo = buildVtimezone("Asia/Tokyo", start, end);
	assert.equal(tokyo.filter((line) => line.startsWith("BEGIN:")).length, 2);
	assert.ok(tokyo.includes("TZOFFSETTO:+0900"));
	assert.ok(buildVtimezone("Asia/Kathmandu", start, end).includes("TZOFFSETTO:+0545"));
	const stJohns = buildVtimezone("America/St_Johns", start, end);
	assert.ok(stJohns.includes("TZOFFSETFROM:-0330") && stJohns.includes("TZOFFSETTO:-0230"));
	// The southern hemisphere moves the clock forward in spring there, which is still DAYLIGHT.
	const sydney = buildVtimezone("Australia/Sydney", start, end);
	assert.equal(sydney[2], "BEGIN:DAYLIGHT");
	assert.ok(sydney.includes("DTSTART:20261004T020000"));
});

test("every TZID in the feed has its VTIMEZONE, once, before the events", () => {
	const series = (id, timeZone) => ({ ...base, id, repeat: "weekly", timeZone });
	const ics = feed([series("a", "Europe/Amsterdam"), series("b", "Europe/Amsterdam"), series("c", "Asia/Tokyo"), base]);
	const all = lines(ics);
	const used = new Set(all.flatMap((line) => line.match(/;TZID=([^:;]+)/)?.[1] ?? []));
	const defined = all.filter((line) => line.startsWith("TZID:")).map((line) => line.slice(5));
	assert.deepEqual([...used].sort(), ["Asia/Tokyo", "Europe/Amsterdam"]);
	assert.deepEqual([...defined].sort(), ["Asia/Tokyo", "Europe/Amsterdam"]);
	assert.ok(all.lastIndexOf("END:VTIMEZONE") < all.indexOf("BEGIN:VEVENT"));
	// Ten years ahead of now, so a series running on is still described.
	assert.ok(all.includes("DTSTART:20351028T030000"), "the last Amsterdam change inside the window");
	// UTC events and whole dates name no zone and need none.
	assert.equal(lines(feed([base])).includes("BEGIN:VTIMEZONE"), false);
});
