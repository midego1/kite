import assert from "node:assert/strict";
import test from "node:test";
import {
	FALLBACK_PROPOSAL_INTRO,
	deserializeEventRow,
	formatProposalSlots,
	inviteEventValues,
	inviteOptionRefusal,
	namesATime,
	proposalBody,
	rsvpSubject,
	rsvpText,
	serializeEventRow,
	snapshotEvent,
	snapshotValues,
} from "../src/lib/agent/auto-read/invite-actions-utils.ts";

const payload = (extra = {}) => ({
	uid: "uid-1",
	sequence: 0,
	method: "REQUEST",
	organizer: "alice@partner.test",
	start: "2030-03-12T10:00:00.000Z",
	end: "2030-03-12T11:00:00.000Z",
	tz: "Europe/Amsterdam",
	summary: "Planning",
	location: "Room 1",
	repeats: false,
	conflicts: [],
	proposals: [],
	organizerMatchesSender: true,
	authPassed: true,
	existingEventId: null,
	...extra,
});
const ask = (extra = {}) =>
	inviteOptionRefusal({ option: "accept", status: "open", payload: payload(), rsvp: null, canSend: true, ...extra });

test("a new request can be accepted, declined or answered with a proposal while open", () => {
	for (const option of ["accept", "decline", "propose"]) assert.equal(ask({ option }), null, option);
	assert.equal(ask({ status: "accepted" }).status, 409);
	assert.equal(ask({ status: "dismissed" }).status, 409);
});

test("update and cancel invitations only allow their own option", () => {
	const update = payload({ existingEventId: "evt-1", sequence: 2 });
	assert.equal(ask({ option: "update", payload: update }), null);
	assert.equal(ask({ option: "accept", payload: update }).status, 400);
	const cancel = payload({ method: "CANCEL", existingEventId: "evt-1" });
	assert.equal(ask({ option: "remove", payload: cancel }), null);
	assert.equal(ask({ option: "decline", payload: cancel }).status, 400);
	assert.equal(ask({ option: "remove" }).status, 400);
	assert.equal(ask({ option: "nonsense" }).status, 400);
});

test("sending options need the send permission and an organizer", () => {
	for (const option of ["accept", "decline", "propose", "decline_instead", "accept_instead"])
		assert.equal(ask({ option, canSend: false }).status, 403, option);
	assert.equal(ask({ option: "update", payload: payload({ existingEventId: "evt-1" }), canSend: false }), null);
	assert.equal(ask({ payload: payload({ organizer: null }) }).status, 409);
	assert.equal(ask({ option: "propose", payload: payload({ organizer: null }) }), null);
});

test("decline_instead and accept_instead follow the reply that currently stands", () => {
	const instead = (option, rsvp, status = "accepted") => ask({ option, status, rsvp });
	assert.equal(instead("decline_instead", "accepted"), null);
	assert.equal(instead("decline_instead", null), null);
	assert.equal(instead("decline_instead", "declined").status, 409);
	assert.equal(instead("accept_instead", "declined"), null);
	assert.equal(instead("accept_instead", "accepted").status, 409);
	assert.equal(instead("accept_instead", "declined", "open").status, 409);
});

test("reply subject and text come from the summary on one line", () => {
	assert.equal(rsvpSubject("accepted", "  Plan\nning "), "Accepted: Plan ning");
	assert.equal(rsvpSubject("declined", ""), "Declined: Invitation");
	assert.equal(rsvpSubject("accepted", "x".repeat(400)).length, 200);
	assert.match(rsvpText("declined", "Planning"), /cannot attend/);
	assert.match(rsvpText("accepted", ""), /will attend/);
});

test("slots are formatted in the viewer's time zone", () => {
	const slots = [{ start: "2030-03-12T10:00:00.000Z", end: "2030-03-12T11:30:00.000Z" }];
	assert.deepEqual(formatProposalSlots(slots, "UTC"), ["Tue, 12 Mar 2030, 10:00-11:30 (UTC)"]);
	assert.deepEqual(formatProposalSlots(slots, "Asia/Tokyo"), ["Tue, 12 Mar 2030, 19:00-20:30 (Asia/Tokyo)"]);
	const body = proposalBody("  ", slots, "UTC");
	assert.equal(body, `${FALLBACK_PROPOSAL_INTRO}\n\n- Tue, 12 Mar 2030, 10:00-11:30 (UTC)`);
	assert.ok(proposalBody("Hello.", slots, "UTC").startsWith("Hello.\n\n- "));
});

test("generated intros that name a clock time are detected", () => {
	for (const text of ["How about 3pm?", "Maybe 14:30 works", "At 9 am", "10.15 is free"])
		assert.equal(namesATime(text), true, text);
	for (const text of ["That time does not work.", "Room 12 is booked", "Version 2.0 shipped"])
		assert.equal(namesATime(text), false, text);
});

test("event values keep the organizer's UID and SEQUENCE, and leave mailboxId empty", () => {
	const now = new Date("2030-01-01T00:00:00.000Z");
	const values = inviteEventValues(payload({ location: null, sequence: 3 }), {
		id: "evt-1",
		userId: "owner",
		messageId: "msg-1",
		now,
	});
	assert.equal(values.mailboxId, null);
	assert.equal(values.icalUid, "uid-1");
	assert.equal(values.icalSequence, 3);
	assert.equal(values.location, "");
	assert.equal(values.status, "confirmed");
	assert.equal(values.sourceMessageId, "msg-1");
	assert.equal(values.startsAt.toISOString(), "2030-03-12T10:00:00.000Z");
	assert.equal(
		inviteEventValues(payload({ summary: " " }), { id: "e", userId: "u", messageId: "m", now }).title,
		"Untitled event",
	);
});

test("event rows round-trip through their JSON snapshots", () => {
	const row = {
		id: "evt-1",
		userId: "owner",
		mailboxId: null,
		title: "Planning",
		description: "",
		location: "Room",
		attendees: "[]",
		color: "blue",
		repeat: "none",
		repeatDays: "[]",
		repeatAnchorDay: null,
		repeatUntil: null,
		excludedOccurrences: "[]",
		timeZone: "UTC",
		startsAt: new Date(1_900_000_000_000),
		endsAt: new Date(1_900_003_600_000),
		icalUid: "uid-1",
		icalSequence: 2,
		organizer: "alice@partner.test",
		sourceMessageId: "msg-1",
		status: "confirmed",
		createdAt: new Date(1_800_000_000_000),
		updatedAt: new Date(1_800_000_000_000),
	};
	const json = JSON.parse(JSON.stringify(serializeEventRow(row)));
	assert.deepEqual(deserializeEventRow(json), row);
	assert.equal(deserializeEventRow(null), null);
	assert.equal(deserializeEventRow({ id: "x" }), null);
	const snapshot = snapshotEvent(row);
	assert.deepEqual(snapshotValues(snapshot).startsAt, row.startsAt);
	assert.equal(snapshot.icalSequence, 2);
});
