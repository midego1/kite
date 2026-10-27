import assert from "node:assert/strict";
import test from "node:test";
import { canonicalSnapshotJson, draftSaveChangesPayload } from "../src/lib/agent/approvals/snapshot-utils.ts";

const snapshot = {
	from: '"Support" <support@example.com>',
	to: "sophie@example.com",
	cc: null,
	bcc: null,
	subject: "Re: Files",
	text: "Hi Sophie",
	html: "<p>Hi Sophie</p>",
	inReplyTo: "<a@example.com>",
	references: "<a@example.com>",
	threadId: "t1",
	mailboxId: "mb1",
	scheduledAt: null,
	attachments: [
		{ id: "att_b", filename: "b.png", size: 2, digest: "bb" },
		{ id: "att_a", filename: "a.png", size: 1, digest: "aa" },
	],
};

test("the same draft read again, in another key or attachment order, gives the same snapshot text", () => {
	const reread = {
		attachments: [
			{ digest: "aa", size: 1, filename: "a.png", id: "att_a" },
			{ digest: "bb", size: 2, filename: "b.png", id: "att_b" },
		],
		...Object.fromEntries(
			Object.entries(snapshot)
				.reverse()
				.filter(([key]) => key !== "attachments"),
		),
	};
	assert.equal(canonicalSnapshotJson(reread), canonicalSnapshotJson(snapshot));
});

test("the snapshot text keeps the order it had before, so pending reviews survive the release", () => {
	const sorted = { ...snapshot, attachments: [...snapshot.attachments].sort((a, b) => a.id.localeCompare(b.id)) };
	assert.equal(canonicalSnapshotJson(snapshot), JSON.stringify(sorted));
});

test("any sendable change gives a different snapshot text", () => {
	for (const change of [
		{ subject: "Re: Files!" },
		{ html: "<p>Hi Sophie.</p>" },
		{ to: "other@example.com" },
		{ scheduledAt: "2026-10-28T09:00:00.000Z" },
		{ attachments: snapshot.attachments.slice(1) },
	])
		assert.notEqual(canonicalSnapshotJson({ ...snapshot, ...change }), canonicalSnapshotJson(snapshot));
});

const row = {
	mailboxId: "mb1",
	fromAddr: '"Support" <support@example.com>',
	toAddr: "sophie@example.com",
	ccAddr: null,
	bccAddr: null,
	subject: "Re: Files",
	textBody: "Hi Sophie",
	htmlBody: "<p>Hi Sophie</p>",
	scheduledAt: null,
};

test("an autosave that writes the same values is not a change", () => {
	assert.equal(draftSaveChangesPayload(row, { ...row }), false);
	assert.equal(draftSaveChangesPayload(row, { ...row, scheduledAt: undefined }), false);
	const scheduled = { ...row, scheduledAt: new Date("2026-10-28T09:00:00Z") };
	assert.equal(draftSaveChangesPayload(scheduled, { ...row, scheduledAt: new Date("2026-10-28T09:00:00Z") }), false);
});

test("a save that changes a sendable field or the schedule is a change", () => {
	assert.equal(draftSaveChangesPayload(row, { ...row, subject: "Re: Files!" }), true);
	assert.equal(draftSaveChangesPayload(row, { ...row, htmlBody: "<p>Hi</p>" }), true);
	assert.equal(draftSaveChangesPayload(row, { ...row, bccAddr: "boss@example.com" }), true);
	assert.equal(draftSaveChangesPayload(row, { ...row, scheduledAt: new Date("2026-10-28T09:00:00Z") }), true);
});
