import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

const { eventBlockLayout, inlineEventText } = await bundleModules("kite-calendar-event-block-", [
	["eventBlockLayout", "src/app/(calendar)/calendar/event-block-utils.ts"],
	["inlineEventText", "src/app/(calendar)/calendar/event-block-utils.ts"],
]);

// The grid draws 36px per hour (CALENDAR_HOUR_HEIGHT), so these are the real block heights.
const HOUR = 36;
const minutes = (count) => (count * HOUR) / 60;

test("a one-hour event shows the title over the time", () => {
	assert.deepEqual(eventBlockLayout(minutes(60)), { mode: "stacked", paddingClass: "py-0.5" });
});

test("a half-hour event degrades to one line", () => {
	assert.deepEqual(eventBlockLayout(minutes(30)), { mode: "inline", paddingClass: "py-px" });
	assert.equal(eventBlockLayout(minutes(45)).mode, "inline");
});

test("an event too short for a line of text draws none", () => {
	assert.equal(eventBlockLayout(minutes(15)).mode, "none");
	assert.equal(eventBlockLayout(0).mode, "none");
});

test("longer events get roomier padding", () => {
	assert.deepEqual(eventBlockLayout(minutes(120)), { mode: "stacked", paddingClass: "py-1.5" });
});

test("each mode leaves room for its lines plus padding", () => {
	// One 16px line plus 1px of padding on each side, then two lines plus 2px on each side.
	assert.equal(eventBlockLayout(17.99).mode, "none");
	assert.equal(eventBlockLayout(18).mode, "inline");
	assert.equal(eventBlockLayout(35.99).mode, "inline");
	assert.equal(eventBlockLayout(36).mode, "stacked");
});

test("the inline line reads title, start time", () => {
	assert.equal(
		inlineEventText({ title: "Standup", startLabel: "10 AM", endLabel: "10:30 AM", startsOnDay: true }),
		"Standup, 10 AM",
	);
});

test("the piece of an event that began on an earlier day says when it ends instead", () => {
	assert.equal(
		inlineEventText({ title: "Night shift", startLabel: "11 PM", endLabel: "12:30 AM", startsOnDay: false }),
		"Night shift, until 12:30 AM",
	);
});
