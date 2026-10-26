import assert from "node:assert/strict";
import test from "node:test";
import { sentDraftState } from "../src/lib/agent/approvals/draft-state-utils.ts";
import { draftStateHeading, isFinishedDraftState } from "../src/components/agent/draft-card-utils.ts";

const NOW = new Date("2026-10-26T12:00:00.000Z");
const message = { id: "m1", status: "sent", subject: "Re: Files", toAddr: "sophie@example.com" };

test("a draft that was never sent is unavailable", () => {
	assert.deepEqual(sentDraftState({ approvedMessageId: null, message: null, job: null, now: NOW }), {
		state: "unavailable",
	});
});

test("a confirmed send reports the message details", () => {
	assert.deepEqual(
		sentDraftState({ approvedMessageId: "m1", message, job: { status: "sent", scheduledAt: null }, now: NOW }),
		{ state: "sent", messageId: "m1", subject: "Re: Files", to: "sophie@example.com" },
	);
});

test("a send the caller cannot read is still sent, without details", () => {
	assert.deepEqual(sentDraftState({ approvedMessageId: "m1", message: null, job: null, now: NOW }), {
		state: "sent",
		messageId: null,
		subject: null,
		to: null,
	});
});

test("a queued job with a future time is scheduled", () => {
	const scheduledAt = new Date("2026-10-27T09:00:00.000Z");
	const state = sentDraftState({
		approvedMessageId: "m1",
		message: { ...message, status: "queued" },
		job: { status: "queued", scheduledAt },
		now: NOW,
	});
	assert.equal(state.state, "scheduled");
	assert.equal(state.scheduledAt, "2026-10-27T09:00:00.000Z");
});

test("a send that has not finished is sending, not sent, even after its scheduled time", () => {
	const late = new Date("2026-10-26T11:00:00.000Z");
	for (const status of ["queued", "sending"])
		assert.equal(
			sentDraftState({
				approvedMessageId: "m1",
				message: { ...message, status },
				job: { status, scheduledAt: late },
				now: NOW,
			}).state,
			"sending",
		);
	assert.equal(
		sentDraftState({ approvedMessageId: "m1", message: { ...message, status: "queued" }, job: null, now: NOW }).state,
		"sending",
	);
});

test("an undone send is unavailable", () => {
	assert.deepEqual(
		sentDraftState({
			approvedMessageId: "m1",
			message: { ...message, status: "draft" },
			job: { status: "cancelled", scheduledAt: null },
			now: NOW,
		}),
		{ state: "unavailable" },
	);
});

test("a failed delivery is reported as failed", () => {
	assert.equal(
		sentDraftState({
			approvedMessageId: "m1",
			message: { ...message, status: "failed" },
			job: { status: "failed", scheduledAt: null },
			now: NOW,
		}).state,
		"failed",
	);
});

test("card headings and which states end the draft", () => {
	const finished = (state) => sentDraftState({ approvedMessageId: "m1", message, job: null, now: NOW, ...state });
	assert.equal(draftStateHeading(finished({}), String), "Sent");
	assert.equal(
		draftStateHeading(
			{ state: "scheduled", messageId: null, subject: null, to: null, scheduledAt: "2026-10-27T09:00:00.000Z" },
			(iso) => `at ${iso}`,
		),
		"Scheduled for at 2026-10-27T09:00:00.000Z",
	);
	assert.equal(
		draftStateHeading({ state: "failed", messageId: null, subject: null, to: null }, String),
		"Sending failed",
	);
	assert.equal(isFinishedDraftState({ state: "draft" }), false);
	assert.equal(isFinishedDraftState({ state: "unavailable" }), false);
	assert.equal(isFinishedDraftState(finished({})), true);
});
