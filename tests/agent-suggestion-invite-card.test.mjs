import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-agent-invite-card-");
after(() => rmSync(outDir, { recursive: true, force: true }));

for (const name of ["suggestion-invite-utils", "suggestion-card-utils"])
	await build({
		entryPoints: [join(root, `src/components/agent/${name}.ts`)],
		outfile: join(outDir, `${name}.mjs`),
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		logLevel: "silent",
	});
const invite = await import(pathToFileURL(join(outDir, "suggestion-invite-utils.mjs")).href);
const card = await import(pathToFileURL(join(outDir, "suggestion-card-utils.mjs")).href);

const payload = {
	uid: "u1@partner.test",
	sequence: 0,
	method: "REQUEST",
	organizer: "alice@partner.test",
	start: "2026-10-13T08:00:00.000Z",
	end: "2026-10-13T08:30:00.000Z",
	tz: "Europe/Amsterdam",
	summary: "Planning",
	location: null,
	repeats: false,
	conflicts: [],
	proposals: [],
	organizerMatchesSender: true,
	authPassed: true,
};
const suggestion = (extra = {}, over = {}) => ({
	id: "s1",
	mailboxId: "mb",
	kind: "calendar_invite",
	status: "open",
	payload: { ...payload, ...extra },
	...over,
});
const action = (over) => ({ suggestionId: "s1", undoOf: null, status: "applied", variant: "", ...over });

test("the invite payload is read defensively", () => {
	assert.equal(invite.invitePayload({ payload: {} }), null);
	const read = invite.invitePayload(
		suggestion({ conflicts: [{ title: 3 }, { eventId: "e", title: "A", start: payload.start, end: payload.end }] }),
	);
	assert.equal(read.conflicts.length, 1);
	assert.deepEqual(invite.invitePayload(suggestion({ proposals: "x" })).proposals, []);
});

test("times are shown in the viewer's zone, across midnight too", () => {
	assert.match(invite.formatInviteRange(payload.start, payload.end, "Europe/Amsterdam"), /10:00.*10:30/);
	assert.match(invite.formatInviteRange(payload.start, payload.end, "UTC"), /08:00.*08:30/);
	const spanning = invite.formatInviteRange("2026-10-13T23:30:00Z", "2026-10-14T00:30:00Z", "UTC");
	assert.match(spanning, /13.*11:30.*14.*12:30|13.*23:30.*14.*00:30/);
});

test("buttons follow the invitation's shape", () => {
	const labels = (extra) => invite.inviteButtons(invite.invitePayload(suggestion(extra))).map((button) => button.label);
	assert.deepEqual(labels({}), ["Accept", "Decline", "Propose new time"]);
	assert.deepEqual(labels({ organizer: null }), ["Accept", "Decline"]);
	assert.deepEqual(labels({ existingEventId: "e1" }), ["Update event"]);
	assert.deepEqual(labels({ method: "CANCEL", existingEventId: "e1" }), ["Remove from calendar"]);
});

test("warnings name an unverified sender and an organizer mismatch", () => {
	assert.deepEqual(invite.inviteWarnings(payload), []);
	assert.equal(invite.inviteWarnings({ ...payload, authPassed: false, organizerMatchesSender: false }).length, 2);
});

test("the answer comes from live rows only", () => {
	const rows = [
		action({ id: "a4", action: "send_rsvp", variant: "accepted" }),
		action({ id: "a3", action: "send_rsvp", variant: "declined", status: "undone" }),
		action({ id: "a2", action: "send_rsvp", variant: "accepted", status: "undone" }),
		action({ id: "a1", action: "create_event", status: "undone" }),
		action({ id: "x", action: "send_rsvp", variant: "declined", suggestionId: "other" }),
	];
	assert.deepEqual(invite.inviteAnswer("s1", rows), { rsvp: "accepted", eventActionId: null });
	assert.match(invite.answeredText({ rsvp: "accepted", eventActionId: null }, payload), /not on your calendar/);
	assert.equal(
		invite.answeredText({ rsvp: "declined", eventActionId: null }, payload),
		"You declined this invitation.",
	);
	assert.equal(
		invite.answeredText({ rsvp: null, eventActionId: "a" }, { ...payload, method: "CANCEL" }),
		"Removed from your calendar.",
	);
	assert.deepEqual(
		invite.inviteAnswer("s1", [action({ id: "u", action: "send_rsvp", variant: "declined", undoOf: "a" })]),
		{
			rsvp: null,
			eventActionId: null,
		},
	);
});

test("the card lists the invitation before the reply and keeps an answered one", () => {
	const items = [suggestion({}, { id: "i1" }), { id: "r1", mailboxId: "mb", kind: "reply", status: "open" }];
	const sections = card.cardSections(items, "mb", [suggestion({}, { id: "i0", status: "accepted" })]);
	assert.deepEqual(
		sections.blocks.map((block) => block.id),
		["i1", "r1"],
	);
	assert.equal(sections.answered.id, "i0");
	assert.equal(card.hasCardContent(card.cardSections([], "mb", [suggestion({}, { status: "accepted" })])), true);
	assert.ok(card.answeredInviteUrl("m1", "t1").includes("status=accepted"));
});
