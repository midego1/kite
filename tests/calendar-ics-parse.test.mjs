import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-ics-parse-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/lib/calendar/ics-parse-utils.ts")],
	outfile: join(outDir, "ics.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	alias: { "@": join(root, "src") },
	external: ["react", "react-dom", "next", "next/*"],
});
const { parseIcsInvite, ICS_MAX_BYTES } = await import(pathToFileURL(join(outDir, "ics.mjs")).href);

const fixture = (name) => readFileSync(join(root, "tests/fixtures/ics", name), "utf8");
const wrap = (lines, method = "REQUEST") =>
	["BEGIN:VCALENDAR", "VERSION:2.0", `METHOD:${method}`, "BEGIN:VEVENT", ...lines, "END:VEVENT", "END:VCALENDAR"].join(
		"\r\n",
	);

test("Google fixture: folded attendee lines, escapes, nested alarm ignored", () => {
	const result = parseIcsInvite(fixture("google.ics"));
	assert.equal(result.ok, true);
	const invite = result.invite;
	assert.equal(invite.method, "REQUEST");
	assert.equal(invite.uid, "abc123synthetic@google.com");
	assert.equal(invite.sequence, 2);
	assert.equal(invite.start, "2026-04-15T13:00:00.000Z");
	assert.equal(invite.end, "2026-04-15T14:00:00.000Z");
	assert.equal(invite.tz, null);
	assert.equal(invite.allDay, false);
	assert.equal(invite.summary, "Quarterly planning, round 2");
	assert.equal(invite.location, "Room 4; Building B");
	assert.deepEqual(invite.organizer, { email: "olivia@example.org", name: "Olivia Organizer" });
	assert.deepEqual(invite.attendees, [
		{ email: "reviewer@example.com", name: "Reviewer", partstat: "NEEDS-ACTION" },
		{ email: "olivia@example.org", name: "Olivia Organizer", partstat: "ACCEPTED" },
	]);
	assert.equal(invite.rrule, null);
});

test("Outlook fixture: a Windows TZID is rejected instead of guessed", () => {
	assert.deepEqual(parseIcsInvite(fixture("outlook.ics")), { ok: false, error: "unknown_timezone" });
});

test("Outlook-style UTC invite parses with MAILTO: in upper case", () => {
	const source = fixture("outlook.ics")
		.replace(/DTSTART;TZID=[^:]+:20260415T150000/, "DTSTART:20260415T130000Z")
		.replace(/DTEND;TZID=[^:]+:20260415T160000/, "DTEND:20260415T140000Z");
	const result = parseIcsInvite(source);
	assert.equal(result.ok, true);
	assert.equal(result.invite.organizer.email, "oscar@example.net");
	assert.equal(result.invite.organizer.name, "Oscar Outlook");
	assert.equal(result.invite.summary, "Sync");
	assert.equal(result.invite.uid, "040000008200E00074C5B7101A82E00800000000SYNTHETIC");
});

test("Apple fixture: IANA TZID, DURATION and raw RRULE", () => {
	const { ok, invite } = parseIcsInvite(fixture("apple.ics"));
	assert.equal(ok, true);
	assert.equal(invite.tz, "Europe/Amsterdam");
	assert.equal(invite.start, "2026-04-15T08:00:00.000Z");
	assert.equal(invite.end, "2026-04-15T08:45:00.000Z");
	assert.equal(invite.rrule, "FREQ=WEEKLY;BYDAY=WE;COUNT=10");
	assert.equal(invite.sequence, 1);
	assert.equal(invite.attendees[0].partstat, "TENTATIVE");
	assert.equal(invite.organizer.email, "anna@example.com");
});

test("TZID conversion honours winter time", () => {
	const result = parseIcsInvite(
		wrap(["UID:a", "DTSTART;TZID=Europe/Amsterdam:20260115T100000", "DTEND;TZID=Europe/Amsterdam:20260115T110000"]),
	);
	assert.equal(result.invite.start, "2026-01-15T09:00:00.000Z");
});

test("folded lines are unfolded with LF and tab continuations", () => {
	const result = parseIcsInvite(
		"BEGIN:VEVENT\nUID:fold\nDTSTART:20260415T130000Z\nSUMMARY:One\n two\n\tthree\nEND:VEVENT",
	);
	assert.equal(result.invite.summary, "Onetwothree");
});

test("all-day events (VALUE=DATE) default to one day", () => {
	const result = parseIcsInvite(wrap(["UID:d", "DTSTART;VALUE=DATE:20260415"]));
	assert.equal(result.invite.allDay, true);
	assert.equal(result.invite.start, "2026-04-15T00:00:00.000Z");
	assert.equal(result.invite.end, "2026-04-16T00:00:00.000Z");
	const multi = parseIcsInvite(wrap(["UID:d", "DTSTART;VALUE=DATE:20260415", "DTEND;VALUE=DATE:20260418"]));
	assert.equal(multi.invite.end, "2026-04-18T00:00:00.000Z");
});

test("DURATION supports weeks, days and hours", () => {
	const hours = parseIcsInvite(wrap(["UID:h", "DTSTART:20260415T130000Z", "DURATION:PT1H30M"]));
	assert.equal(hours.invite.end, "2026-04-15T14:30:00.000Z");
	const days = parseIcsInvite(wrap(["UID:h", "DTSTART:20260415T130000Z", "DURATION:P1DT2H"]));
	assert.equal(days.invite.end, "2026-04-16T15:00:00.000Z");
	const weeks = parseIcsInvite(wrap(["UID:h", "DTSTART:20260415T130000Z", "DURATION:P1W"]));
	assert.equal(weeks.invite.end, "2026-04-22T13:00:00.000Z");
	assert.equal(parseIcsInvite(wrap(["UID:h", "DTSTART:20260415T130000Z", "DURATION:bogus"])).error, "invalid_time");
	assert.equal(parseIcsInvite(wrap(["UID:h", "DTSTART:20260415T130000Z", "DURATION:-PT1H"])).error, "invalid_time");
});

test("a missing end gives a zero-length timed event", () => {
	const result = parseIcsInvite(wrap(["UID:z", "DTSTART:20260415T130000Z"]));
	assert.equal(result.invite.start, result.invite.end);
});

test("METHOD:CANCEL is reported", () => {
	const result = parseIcsInvite(wrap(["UID:c", "SEQUENCE:3", "DTSTART:20260415T130000Z"], "CANCEL"));
	assert.equal(result.invite.method, "CANCEL");
	assert.equal(result.invite.sequence, 3);
});

test("missing METHOD is null; bad SEQUENCE is 0", () => {
	const result = parseIcsInvite("BEGIN:VEVENT\r\nUID:m\r\nSEQUENCE:x\r\nDTSTART:20260415T130000Z\r\nEND:VEVENT");
	assert.equal(result.invite.method, null);
	assert.equal(result.invite.sequence, 0);
});

test("oversize input is rejected", () => {
	const big = wrap(["UID:b", "DTSTART:20260415T130000Z", `DESCRIPTION:${"x".repeat(ICS_MAX_BYTES)}`]);
	assert.deepEqual(parseIcsInvite(big), { ok: false, error: "too_large" });
	assert.deepEqual(parseIcsInvite("BEGIN:VEVENT\r\nUID:b\r\nDTSTART:20260415T130000Z\r\nEND:VEVENT", 10), {
		ok: false,
		error: "too_large",
	});
});

test("unknown, offset-style and floating times are rejected", () => {
	for (const tzid of ["Mars/Phobos", "Eastern Standard Time", '"+01:00"', "/mozilla.org/Europe/Paris"]) {
		const result = parseIcsInvite(wrap(["UID:t", `DTSTART;TZID=${tzid}:20260415T130000`]));
		assert.equal(result.error, "unknown_timezone", tzid);
	}
	assert.equal(parseIcsInvite(wrap(["UID:t", "DTSTART:20260415T130000"])).error, "floating_time");
});

test("structural failures", () => {
	assert.equal(parseIcsInvite("BEGIN:VCALENDAR\r\nEND:VCALENDAR").error, "no_event");
	assert.equal(parseIcsInvite(wrap(["DTSTART:20260415T130000Z"])).error, "missing_uid");
	assert.equal(parseIcsInvite(wrap(["UID:x"])).error, "invalid_time");
	assert.equal(parseIcsInvite(wrap(["UID:x", "DTSTART:20261345T130000Z"])).error, "invalid_time");
	assert.equal(parseIcsInvite(wrap(["UID:x", "DTSTART:garbage"])).error, "invalid_time");
	assert.equal(
		parseIcsInvite(wrap(["UID:x", "DTSTART:20260415T130000Z", "DTEND:20260415T120000Z"])).error,
		"invalid_time",
	);
	assert.equal(
		parseIcsInvite(wrap(["UID:x", "DTSTART:20260415T130000Z", "DTEND;VALUE=DATE:20260416"])).error,
		"invalid_time",
	);
});

test("only the first VEVENT is read; attendees without an address are skipped", () => {
	const source = [
		"BEGIN:VEVENT",
		"UID:first",
		"DTSTART:20260415T130000Z",
		"ATTENDEE;CN=Nobody:urn:nothing",
		'ORGANIZER;CN="Quoted; Name":mailto:Boss@Example.com',
		"END:VEVENT",
		"BEGIN:VEVENT",
		"UID:second",
		"DTSTART:20260416T130000Z",
		"END:VEVENT",
	].join("\r\n");
	const { invite } = parseIcsInvite(source);
	assert.equal(invite.uid, "first");
	assert.deepEqual(invite.attendees, []);
	assert.deepEqual(invite.organizer, { email: "boss@example.com", name: "Quoted; Name" });
	assert.equal(parseIcsInvite("BEGIN:VEVENT\r\nUID:open").error, "no_event");
});
