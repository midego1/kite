import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-calendar-availability-");
after(() => rmSync(outDir, { recursive: true, force: true }));

async function bundle(entry, outfile) {
	await build({
		entryPoints: [join(root, entry)],
		outfile: join(outDir, outfile),
		bundle: true,
		sourcemap: "inline",
		platform: "node",
		format: "esm",
		target: "node22",
		logLevel: "silent",
		alias: { "@": join(root, "src") },
		external: ["react", "react-dom", "next", "next/*"],
	});
	return import(pathToFileURL(join(outDir, outfile)).href);
}
const { busyBlocks, findConflicts, proposeSlots } = await bundle("src/lib/calendar/availability-utils.ts", "avail.mjs");
const { expandToolEvents } = await bundle("src/lib/calendar/tool-occurrences.ts", "occurrences.mjs");

const row = (overrides) => ({
	id: "e1",
	userId: "u1",
	title: "Event",
	description: "",
	location: "",
	attendees: "[]",
	color: "blue",
	repeat: "none",
	repeatDays: "[]",
	repeatAnchorDay: null,
	repeatUntil: null,
	excludedOccurrences: "[]",
	timeZone: "Europe/Amsterdam",
	startsAt: new Date("2026-04-15T09:00:00Z"),
	endsAt: new Date("2026-04-15T10:00:00Z"),
	...overrides,
});

// The pre-refactor body of find_free_time, kept verbatim as the reference.
function legacyBusy(events, from, to) {
	return events
		.map((event) => ({
			start: Math.max(from.getTime(), Date.parse(event.startsAt)),
			end: Math.min(to.getTime(), Date.parse(event.endsAt)),
		}))
		.sort((a, b) => a.start - b.start);
}

test("busyBlocks matches the original find_free_time computation, recurring events included", () => {
	const from = new Date("2026-04-13T00:00:00Z");
	const to = new Date("2026-04-20T00:00:00Z");
	const events = expandToolEvents(
		[
			row({ id: "a", startsAt: new Date("2026-04-12T23:30:00Z"), endsAt: new Date("2026-04-13T01:00:00Z") }),
			row({
				id: "b",
				repeat: "daily",
				startsAt: new Date("2026-04-10T07:00:00Z"),
				endsAt: new Date("2026-04-10T08:00:00Z"),
			}),
			row({ id: "c", startsAt: new Date("2026-04-19T23:00:00Z"), endsAt: new Date("2026-04-20T03:00:00Z") }),
			row({ id: "d", startsAt: new Date("2026-04-15T09:30:00Z"), endsAt: new Date("2026-04-15T09:45:00Z") }),
		],
		from,
		to,
	);
	assert.ok(events.length >= 9);
	const blocks = busyBlocks(events, from, to);
	assert.deepEqual(blocks, legacyBusy(events, from, to));
	assert.equal(blocks[0].start, from.getTime());
	assert.equal(blocks.at(-1).end, to.getTime());
	for (let index = 1; index < blocks.length; index++) assert.ok(blocks[index].start >= blocks[index - 1].start);
});

test("findConflicts returns overlapping events only; touching ends do not conflict", () => {
	const events = [
		{ id: "before", startsAt: "2026-04-15T08:00:00Z", endsAt: "2026-04-15T09:00:00Z" },
		{ id: "inside", startsAt: "2026-04-15T09:15:00Z", endsAt: "2026-04-15T09:45:00Z" },
		{ id: "straddle", startsAt: "2026-04-15T09:50:00Z", endsAt: "2026-04-15T10:30:00Z" },
		{ id: "after", startsAt: "2026-04-15T10:00:00Z", endsAt: "2026-04-15T11:00:00Z" },
	];
	const conflicts = findConflicts(events, new Date("2026-04-15T09:00:00Z"), new Date("2026-04-15T10:00:00Z"));
	assert.deepEqual(
		conflicts.map((event) => event.id),
		["inside", "straddle"],
	);
	assert.deepEqual(findConflicts([], new Date(), new Date()), []);
});

const workHours = { weekdays: [1, 2, 3, 4, 5], ranges: [{ startTime: "09:00", endTime: "17:00" }] };
const localParts = (iso, tz) => {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-GB", {
			timeZone: tz,
			hour: "2-digit",
			minute: "2-digit",
			weekday: "short",
			hourCycle: "h23",
		})
			.formatToParts(new Date(iso))
			.map((part) => [part.type, part.value]),
	);
	return { minutes: Number(parts.hour) * 60 + Number(parts.minute), weekday: parts.weekday };
};

test("proposeSlots stays inside working hours, skips weekends and busy time", () => {
	const from = new Date("2026-04-15T05:00:00Z"); // Wed 07:00 CEST
	const busy = [{ start: Date.parse("2026-04-15T07:00:00Z"), end: Date.parse("2026-04-15T08:00:00Z") }];
	const slots = proposeSlots(busy, 60, workHours, "Europe/Amsterdam", 3, 7, from);
	assert.equal(slots.length, 3);
	assert.equal(slots[0].start, "2026-04-15T08:00:00.000Z");
	for (const slot of slots) {
		const start = localParts(slot.start, "Europe/Amsterdam");
		const end = localParts(slot.end, "Europe/Amsterdam");
		assert.ok(start.minutes >= 9 * 60 && end.minutes <= 17 * 60);
		assert.equal(Date.parse(slot.end) - Date.parse(slot.start), 3_600_000);
		assert.ok(!busy.some((block) => block.start < Date.parse(slot.end) && block.end > Date.parse(slot.start)));
	}
	const weekend = proposeSlots([], 60, workHours, "Europe/Amsterdam", 20, 7, new Date("2026-04-17T14:00:00Z"));
	assert.ok(weekend.every((slot) => !["Sat", "Sun"].includes(localParts(slot.start, "Europe/Amsterdam").weekday)));
	assert.ok(Date.parse(weekend[0].start) >= Date.parse("2026-04-17T14:00:00Z"));
});

test("proposeSlots honours count, horizon, multiple ranges and invalid input", () => {
	const from = new Date("2026-04-15T00:00:00Z");
	const split = {
		weekdays: [3],
		ranges: [
			{ startTime: "09:00", endTime: "10:00" },
			{ startTime: "14:00", endTime: "15:00" },
		],
	};
	const slots = proposeSlots([], 60, split, "Europe/Amsterdam", 5, 7, from);
	assert.deepEqual(
		slots.map((slot) => slot.start),
		["2026-04-15T07:00:00.000Z", "2026-04-15T12:00:00.000Z", "2026-04-22T07:00:00.000Z"].slice(0, 2),
	);
	assert.equal(proposeSlots([], 60, workHours, "Europe/Amsterdam", 2, 7, from).length, 2);
	assert.deepEqual(proposeSlots([], 60, workHours, "Europe/Amsterdam", 5, 0, new Date("2026-04-15T20:00:00Z")), []);
	assert.deepEqual(proposeSlots([], 600, workHours, "Europe/Amsterdam", 3, 7, from), []);
	const bad = {
		weekdays: [3],
		ranges: [
			{ startTime: "xx", endTime: "10:00" },
			{ startTime: "17:00", endTime: "09:00" },
		],
	};
	assert.deepEqual(proposeSlots([], 30, bad, "Europe/Amsterdam", 3, 7, from), []);
	assert.equal(proposeSlots([], 30, workHours, "Not/AZone", 1, 7, from).length, 1);
	assert.equal(proposeSlots([], 30, workHours, "UTC").length, 3);
});

const everyDay = { weekdays: [0, 1, 2, 3, 4, 5, 6], ranges: [{ startTime: "09:00", endTime: "17:00" }] };

function assertLocalHours(slots, tz, duration) {
	for (const slot of slots) {
		const start = localParts(slot.start, tz).minutes;
		const end = localParts(slot.end, tz).minutes;
		assert.ok(start >= 9 * 60, `${slot.start} starts before 09:00 local`);
		assert.ok(end <= 17 * 60 && end > start, `${slot.end} ends after 17:00 local`);
		assert.equal(Date.parse(slot.end) - Date.parse(slot.start), duration * 60_000);
	}
}

test("proposeSlots across the spring DST change (Europe/Amsterdam, 29 March 2026)", () => {
	const from = new Date("2026-03-27T00:00:00Z");
	const slots = proposeSlots([], 480, everyDay, "Europe/Amsterdam", 4, 5, from);
	assert.deepEqual(
		slots.map((slot) => slot.start),
		["2026-03-27T08:00:00.000Z", "2026-03-28T08:00:00.000Z", "2026-03-29T07:00:00.000Z", "2026-03-30T07:00:00.000Z"],
	);
	assertLocalHours(slots, "Europe/Amsterdam", 480);
	const hourly = proposeSlots([], 60, everyDay, "Europe/Amsterdam", 40, 5, from);
	assertLocalHours(hourly, "Europe/Amsterdam", 60);
	assert.ok(hourly.some((slot) => slot.start === "2026-03-29T07:00:00.000Z"));
});

test("proposeSlots across the autumn DST change (Europe/Amsterdam, 25 October 2026)", () => {
	const from = new Date("2026-10-23T00:00:00Z");
	const slots = proposeSlots([], 480, everyDay, "Europe/Amsterdam", 4, 5, from);
	assert.deepEqual(
		slots.map((slot) => slot.start),
		["2026-10-23T07:00:00.000Z", "2026-10-24T07:00:00.000Z", "2026-10-25T08:00:00.000Z", "2026-10-26T08:00:00.000Z"],
	);
	assertLocalHours(slots, "Europe/Amsterdam", 480);
	const hourly = proposeSlots([], 60, everyDay, "Europe/Amsterdam", 40, 5, from);
	assertLocalHours(hourly, "Europe/Amsterdam", 60);
	assert.ok(hourly.some((slot) => slot.start === "2026-10-25T08:00:00.000Z"));
});
