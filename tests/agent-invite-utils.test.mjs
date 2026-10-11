import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-agent-invite-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/lib/agent/auto-read/invite-utils.ts")],
	outfile: join(outDir, "invite-utils.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	alias: { "@": join(root, "src") },
	external: ["react", "react-dom", "next", "next/*"],
});
const { resolveWorkingHours, inviteVariant, availabilityWindow, overlappingEvents, buildInvitePayload } = await import(
	pathToFileURL(join(outDir, "invite-utils.mjs")).href
);

const invite = {
	method: "REQUEST",
	uid: "uid-1@example.test",
	sequence: 0,
	start: "2030-01-08T10:00:00.000Z",
	end: "2030-01-08T11:00:00.000Z",
	allDay: false,
	tz: "Europe/Amsterdam",
	summary: "Sync",
	location: "",
	organizer: { email: "Alice@External.test", name: null },
	attendees: [],
	rrule: null,
};

test("working hours default to Monday to Friday 09:00-17:00 in the user zone, UTC when unset", () => {
	const fallback = resolveWorkingHours(null, "Europe/Amsterdam");
	assert.deepEqual(fallback.workHours, {
		weekdays: [1, 2, 3, 4, 5],
		ranges: [{ startTime: "09:00", endTime: "17:00" }],
	});
	assert.equal(fallback.tz, "Europe/Amsterdam");
	assert.equal(resolveWorkingHours(null, null).tz, "UTC");
});

test("working hours follow the booking event weekdays, ranges and zone", () => {
	const result = resolveWorkingHours(
		{
			weekdays: "[2,4]",
			timeRanges: '[{"startTime":"13:00","endTime":"15:00"}]',
			startTime: "09:00",
			endTime: "17:00",
			timeZone: "America/New_York",
		},
		"UTC",
	);
	assert.deepEqual(result.workHours, { weekdays: [2, 4], ranges: [{ startTime: "13:00", endTime: "15:00" }] });
	assert.equal(result.tz, "America/New_York");
});

test("malformed booking JSON falls back to the start and end columns", () => {
	const result = resolveWorkingHours(
		{ weekdays: "nope", timeRanges: "[]", startTime: "08:00", endTime: "12:00", timeZone: "Not/AZone" },
		"UTC",
	);
	assert.deepEqual(result.workHours, { weekdays: [1, 2, 3, 4, 5], ranges: [{ startTime: "08:00", endTime: "12:00" }] });
	assert.equal(result.tz, "UTC");
});

test("a new UID is a new event; a higher SEQUENCE updates; equal or lower is ignored", () => {
	assert.deepEqual(inviteVariant(invite, null), { method: "REQUEST", existingEventId: null });
	assert.deepEqual(inviteVariant({ ...invite, sequence: 1 }, { id: "e1", icalSequence: 0 }), {
		method: "REQUEST",
		existingEventId: "e1",
	});
	assert.equal(inviteVariant({ ...invite, sequence: 1 }, { id: "e1", icalSequence: 1 }), null);
	assert.equal(inviteVariant({ ...invite, sequence: 0 }, { id: "e1", icalSequence: 1 }), null);
	assert.deepEqual(inviteVariant({ ...invite, sequence: 1 }, { id: "e1", icalSequence: null }), {
		method: "REQUEST",
		existingEventId: "e1",
	});
});

test("CANCEL needs a stored event; other methods are ignored", () => {
	assert.equal(inviteVariant({ ...invite, method: "CANCEL" }, null), null);
	assert.deepEqual(inviteVariant({ ...invite, method: "CANCEL" }, { id: "e1", icalSequence: 0 }), {
		method: "CANCEL",
		existingEventId: "e1",
	});
	assert.equal(inviteVariant({ ...invite, method: "REPLY" }, null), null);
	assert.deepEqual(inviteVariant({ ...invite, method: null }, null), { method: "REQUEST", existingEventId: null });
});

test("the availability window adds 30 minutes each side and stays within 90 days", () => {
	const { from, to } = availabilityWindow(invite);
	assert.equal(from.toISOString(), "2030-01-08T09:30:00.000Z");
	assert.equal(to.toISOString(), "2030-01-08T11:30:00.000Z");
	const long = availabilityWindow({ ...invite, end: "2031-01-08T11:00:00.000Z" });
	assert.equal(long.to.getTime() - long.from.getTime(), 90 * 86_400_000);
});

test("overlapping events ignore the margin and the stored copy of the same invite", () => {
	const events = [
		{
			id: "a",
			seriesId: "a",
			title: "Margin",
			startsAt: "2030-01-08T09:30:00.000Z",
			endsAt: "2030-01-08T10:00:00.000Z",
		},
		{
			id: "b",
			seriesId: "b",
			title: "Overlap",
			startsAt: "2030-01-08T10:30:00.000Z",
			endsAt: "2030-01-08T12:00:00.000Z",
		},
		{ id: "c", seriesId: "c", title: "Self", startsAt: "2030-01-08T10:00:00.000Z", endsAt: "2030-01-08T11:00:00.000Z" },
	];
	assert.deepEqual(
		overlappingEvents(events, invite, "c").map((event) => event.id),
		["b"],
	);
});

test("the payload carries the full shape, sender match is case-insensitive and CANCEL drops conflicts", () => {
	const conflicts = [
		{
			id: "b",
			seriesId: "b",
			title: "Overlap",
			startsAt: "2030-01-08T10:30:00.000Z",
			endsAt: "2030-01-08T12:00:00.000Z",
		},
	];
	const proposals = [1, 2, 3, 4].map((n) => ({
		start: `2030-01-0${n + 8}T10:00:00.000Z`,
		end: `2030-01-0${n + 8}T11:00:00.000Z`,
	}));
	const payload = buildInvitePayload({
		invite: { ...invite, rrule: "FREQ=WEEKLY" },
		variant: { method: "REQUEST", existingEventId: null },
		senderAddress: "alice@external.test",
		authPassed: true,
		conflicts,
		proposals,
	});
	assert.deepEqual(payload, {
		uid: "uid-1@example.test",
		sequence: 0,
		method: "REQUEST",
		organizer: "Alice@External.test",
		start: invite.start,
		end: invite.end,
		tz: "Europe/Amsterdam",
		summary: "Sync",
		location: null,
		repeats: true,
		conflicts: [{ eventId: "b", title: "Overlap", start: conflicts[0].startsAt, end: conflicts[0].endsAt }],
		proposals: proposals.slice(0, 3),
		organizerMatchesSender: true,
		authPassed: true,
		existingEventId: null,
	});
	const cancel = buildInvitePayload({
		invite: { ...invite, organizer: { email: "ceo@other.test", name: null }, location: "Room 1" },
		variant: { method: "CANCEL", existingEventId: "e1" },
		senderAddress: "alice@external.test",
		authPassed: false,
		conflicts,
		proposals,
	});
	assert.equal(cancel.method, "CANCEL");
	assert.deepEqual(cancel.conflicts, []);
	assert.deepEqual(cancel.proposals, []);
	assert.equal(cancel.organizerMatchesSender, false);
	assert.equal(cancel.location, "Room 1");
	assert.equal(cancel.existingEventId, "e1");
});
