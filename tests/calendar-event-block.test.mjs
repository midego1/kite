import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

const { eventBlockLayout, inlineEventSuffix, INLINE_MIN_HEIGHT, STACKED_MIN_HEIGHT } = await bundleModules(
	"kite-calendar-event-block-",
	[
		["eventBlockLayout", "src/app/(calendar)/calendar/event-block-utils.ts"],
		["inlineEventSuffix", "src/app/(calendar)/calendar/event-block-utils.ts"],
		["INLINE_MIN_HEIGHT", "src/app/(calendar)/calendar/event-block-utils.ts"],
		["STACKED_MIN_HEIGHT", "src/app/(calendar)/calendar/event-block-utils.ts"],
	],
);

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
	assert.equal(INLINE_MIN_HEIGHT, 18);
	assert.equal(STACKED_MIN_HEIGHT, 36);
	assert.equal(eventBlockLayout(INLINE_MIN_HEIGHT - 0.01).mode, "none");
	assert.equal(eventBlockLayout(STACKED_MIN_HEIGHT - 0.01).mode, "inline");
});

test("the inline line reads title, start time", () => {
	assert.equal(inlineEventSuffix("10:00 AM"), ", 10:00 AM");
});
