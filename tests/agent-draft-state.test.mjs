import assert from "node:assert/strict";
import test from "node:test";
import { sentDraftState } from "../src/lib/agent/approvals/draft-state-utils.ts";
import {
	SENDING_POLL_DELAYS_MS,
	draftRefreshDelay,
	draftStateHeading,
	isFinalDraftState,
	isFinishedDraftState,
} from "../src/components/agent/draft-card-utils.ts";

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

test("a sent message is sent even when its job row was never updated", () => {
	for (const status of ["queued", "sending"])
		assert.equal(
			sentDraftState({ approvedMessageId: "m1", message, job: { status, scheduledAt: null }, now: NOW }).state,
			"sent",
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

test("only sent, failed and unavailable are final", () => {
	const base = { messageId: null, subject: null, to: null };
	const finals = [{ state: "sent", ...base }, { state: "failed", ...base }, { state: "unavailable" }];
	const open = [
		{ state: "draft" },
		{ state: "sending", ...base },
		{ state: "scheduled", ...base, scheduledAt: "2026-10-27T09:00:00.000Z" },
	];
	assert.deepEqual(finals.map(isFinalDraftState), [true, true, true]);
	assert.deepEqual(open.map(isFinalDraftState), [false, false, false]);
});

test("a scheduled card looks again just after its time, a sending card backs off and stops", () => {
	const now = Date.parse("2026-10-26T12:00:00.000Z");
	const scheduled = {
		state: "scheduled",
		messageId: null,
		subject: null,
		to: null,
		scheduledAt: "2026-10-26T12:10:00.000Z",
	};
	assert.equal(draftRefreshDelay(scheduled, 0, now), 10 * 60_000 + 3_000);
	assert.equal(draftRefreshDelay({ ...scheduled, scheduledAt: "2026-10-26T11:00:00.000Z" }, 0, now), 1_000);
	assert.equal(draftRefreshDelay({ ...scheduled, scheduledAt: "2027-10-26T11:00:00.000Z" }, 0, now), 3_600_000);
	assert.equal(draftRefreshDelay({ ...scheduled, scheduledAt: "not a date" }, 0, now), null);
	const sending = { state: "sending", messageId: null, subject: null, to: null };
	const delays = SENDING_POLL_DELAYS_MS.map((_, attempt) => draftRefreshDelay(sending, attempt, now));
	assert.deepEqual(delays, SENDING_POLL_DELAYS_MS);
	assert.equal(draftRefreshDelay(sending, SENDING_POLL_DELAYS_MS.length, now), null);
	assert.equal(draftRefreshDelay({ state: "sent", messageId: null, subject: null, to: null }, 0, now), null);
	assert.equal(draftRefreshDelay({ state: "draft" }, 0, now), null);
});
