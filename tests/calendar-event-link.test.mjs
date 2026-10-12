import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

const { calendarEventHref, calendarActionRef, isCalendarAction } = await bundleModules("kite-calendar-event-link-", [
	["calendarEventHref", "src/lib/calendar/event-link-utils.ts"],
	["calendarActionRef, isCalendarAction", "src/lib/agent/auto-read/activity-ref-utils.ts"],
]);

const NOON_UTC = new Date("2026-10-12T12:00:00.000Z");

test("the event link carries the day in the viewer's time zone and the encoded event id", () => {
	assert.equal(calendarEventHref("evt_1", NOON_UTC, "UTC"), "/calendar?date=2026-10-12&event=evt_1");
	assert.equal(calendarEventHref("evt_1", NOON_UTC, "Pacific/Auckland"), "/calendar?date=2026-10-13&event=evt_1");
	assert.equal(calendarEventHref("evt_1", NOON_UTC, "America/Los_Angeles"), "/calendar?date=2026-10-12&event=evt_1");
	assert.equal(calendarEventHref("a&b c", NOON_UTC, "UTC"), "/calendar?date=2026-10-12&event=a%26b%20c");
});

test("an unknown time zone reads as UTC instead of throwing", () => {
	assert.equal(calendarEventHref("evt_1", NOON_UTC, "Not/AZone"), "/calendar?date=2026-10-12&event=evt_1");
});

test("only calendar actions with a recorded event id carry a calendar:event ref", () => {
	for (const action of ["create_event", "delete_event", "send_rsvp"]) assert.equal(isCalendarAction(action), true);
	for (const action of ["create_draft", "move", "dismiss"]) assert.equal(isCalendarAction(action), false);
	assert.deepEqual(calendarActionRef({ action: "create_event", after: { eventId: "evt-1" } }), {
		kind: "calendar:event",
		id: "evt-1",
	});
	assert.equal(calendarActionRef({ action: "send_rsvp", after: null }), null);
	assert.equal(calendarActionRef({ action: "delete_event", after: { eventId: "" } }), null);
	assert.equal(calendarActionRef({ action: "delete_event", after: { eventId: 7 } }), null);
	assert.equal(calendarActionRef({ action: "move", after: { eventId: "evt-1" } }), null);
});
