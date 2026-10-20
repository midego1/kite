import assert from "node:assert/strict";
import test from "node:test";
import {
	createDraftSaveQueue,
	hasDraftContent,
	withoutAttachmentIds,
} from "../src/components/compose/draft-autosave-utils.ts";
import {
	PAST_SCHEDULE_MESSAGE,
	isPastScheduledSend,
	resolveComposerSendTime,
} from "../src/lib/email/undo-send-utils.ts";

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** A save function whose calls stay open until the test settles them. */
function controlledSaves() {
	const calls = [];
	const save = (snapshot, draftId, stale) => {
		const call = { snapshot, draftId, stale, ...deferred() };
		calls.push(call);
		return call.promise;
	};
	return { calls, save };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("an edit made while the first save is in flight updates that draft instead of creating another", async () => {
	const { calls, save } = controlledSaves();
	const ids = [];
	const queue = createDraftSaveQueue({
		save,
		discard: () => assert.fail("nothing to discard"),
		onDraftId: (id) => ids.push(id),
	});

	void queue.enqueue("first");
	await tick();
	assert.equal(calls.length, 1);
	assert.equal(calls[0].draftId, null);

	void queue.enqueue("second");
	void queue.enqueue("third");
	await tick();
	assert.equal(calls.length, 1, "a second save must wait for the first");

	calls[0].resolve("draft_1");
	await tick();
	assert.equal(calls.length, 2);
	assert.deepEqual(
		[calls[1].snapshot, calls[1].draftId],
		["third", "draft_1"],
		"only the latest edit is saved, onto the new draft",
	);
	calls[1].resolve("draft_1");
	await queue.idle();
	assert.equal(queue.draftId, "draft_1");
	assert.deepEqual(ids, ["draft_1"]);
});

test("idle resolves at once when nothing is saving, and after every queued save otherwise", async () => {
	const { calls, save } = controlledSaves();
	const queue = createDraftSaveQueue({ save, discard() {} });
	await queue.idle();

	void queue.enqueue("a");
	let settled = false;
	const idle = queue.idle().then(() => (settled = true));
	await tick();
	void queue.enqueue("b");
	calls[0].resolve("draft_a");
	await tick();
	assert.equal(settled, false, "the save queued behind the first one is still running");
	calls[1].resolve("draft_a");
	await idle;
	assert.equal(settled, true);
});

test("skip drops a waiting save but lets the one in flight keep its draft id", async () => {
	const { calls, save } = controlledSaves();
	const queue = createDraftSaveQueue({ save, discard: () => assert.fail("a skipped save is not discarded") });
	void queue.enqueue("typed");
	await tick();
	void queue.enqueue("typed more");
	queue.skip();
	calls[0].resolve("draft_2");
	await queue.idle();
	assert.equal(calls.length, 1);
	assert.equal(queue.draftId, "draft_2");
});

test("cancel discards a draft the save in flight is still creating", async () => {
	const { calls, save } = controlledSaves();
	const discarded = [];
	const queue = createDraftSaveQueue({ save, discard: (id) => discarded.push(id) });
	void queue.enqueue("first");
	await tick();
	void queue.enqueue("second");
	const cancelled = queue.cancel();
	assert.equal(calls[0].stale(), true, "the running save can see it was abandoned");
	calls[0].resolve("draft_3");
	assert.equal(await cancelled, null);
	assert.deepEqual(discarded, ["draft_3"]);
	assert.equal(calls.length, 1);
	assert.equal(queue.draftId, null);
});

test("cancel keeps an existing draft so the caller can delete it", async () => {
	const { calls, save } = controlledSaves();
	const queue = createDraftSaveQueue({ save, discard: () => assert.fail("an existing draft is never discarded") });
	queue.reset("draft_4");
	void queue.enqueue("edit");
	await tick();
	assert.equal(calls[0].draftId, "draft_4");
	const cancelled = queue.cancel();
	calls[0].resolve("draft_4");
	assert.equal(await cancelled, "draft_4");
});

test("reset points later saves at another draft", async () => {
	const { calls, save } = controlledSaves();
	const queue = createDraftSaveQueue({ save, discard() {} });
	void queue.enqueue("before");
	await tick();
	calls[0].resolve("draft_5");
	await queue.idle();
	queue.reset("draft_restored");
	void queue.enqueue("after");
	await tick();
	assert.equal(calls[1].draftId, "draft_restored");
	assert.equal(calls[1].stale(), false);
	calls[1].resolve("draft_restored");
	await queue.idle();
	queue.reset(null);
	assert.equal(queue.draftId, null);
});

test("a failed save keeps the queue running and the draft id unchanged", async () => {
	let attempt = 0;
	const seen = [];
	const queue = createDraftSaveQueue({
		save: async (snapshot, draftId) => {
			seen.push([snapshot, draftId]);
			attempt += 1;
			if (attempt === 1) throw new Error("offline");
			if (attempt === 2) return null;
			return "draft_6";
		},
		discard() {},
	});
	await queue.enqueue("one");
	assert.equal(queue.draftId, null);
	await queue.enqueue("two");
	await queue.enqueue("three");
	assert.deepEqual(seen, [
		["one", null],
		["two", null],
		["three", null],
	]);
	assert.equal(queue.draftId, "draft_6");
});

test("a save that throws synchronously does not wedge the queue", async () => {
	let calls = 0;
	const queue = createDraftSaveQueue({
		save: () => {
			calls += 1;
			if (calls === 1) throw new Error("sync failure");
			return Promise.resolve("draft_7");
		},
		discard() {},
	});
	await queue.enqueue("one");
	await queue.enqueue("two");
	assert.equal(calls, 2);
	assert.equal(queue.draftId, "draft_7");
});

test("withoutAttachmentIds leaves out files already handled", () => {
	const files = [{ id: "a" }, { id: "b" }, { id: "c" }];
	assert.deepEqual(withoutAttachmentIds(files, new Set(["b"])), [{ id: "a" }, { id: "c" }]);
	assert.deepEqual(withoutAttachmentIds(files, new Set()), files);
	assert.deepEqual(withoutAttachmentIds([], new Set(["a"])), []);
});

test("hasDraftContent ignores an empty composer and a body that is only the signature", () => {
	const empty = { recipients: 0, subject: " ", quotedHtml: null, attachments: 0, bodyText: "", signature: null };
	assert.equal(hasDraftContent(empty), false);
	assert.equal(hasDraftContent({ ...empty, bodyText: "\n-- \nMaya ", signature: "-- \nMaya" }), false);
	assert.equal(hasDraftContent({ ...empty, bodyText: "Hello\n-- \nMaya", signature: "-- \nMaya" }), true);
	assert.equal(hasDraftContent({ ...empty, recipients: 1 }), true);
	assert.equal(hasDraftContent({ ...empty, subject: "Plans" }), true);
	assert.equal(hasDraftContent({ ...empty, quotedHtml: "<p>Earlier</p>" }), true);
	assert.equal(hasDraftContent({ ...empty, attachments: 1 }), true, "a file alone is worth a draft");
});

test("a scheduled send time in the past is refused, within a minute of clock skew", () => {
	const now = Date.parse("2026-10-13T14:05:42.000Z");
	assert.equal(isPastScheduledSend(undefined, now), false);
	assert.equal(isPastScheduledSend(null, now), false);
	assert.equal(isPastScheduledSend("", now), false);
	assert.equal(isPastScheduledSend("2026-10-13T16:00:00.000Z", now), false);
	assert.equal(isPastScheduledSend("2026-10-13T14:05:00.000Z", now), false, "the current minute is allowed");
	assert.equal(isPastScheduledSend("2026-10-13T14:04:43.000Z", now), false);
	assert.equal(isPastScheduledSend("2026-10-13T14:04:41.000Z", now), true);
	assert.equal(isPastScheduledSend("2026-10-13T13:55:42.000Z", now), true);
	assert.equal(isPastScheduledSend(new Date("2020-01-01T09:00:00.000Z"), now), true);
	assert.equal(isPastScheduledSend(new Date("2026-10-14T08:00:00.000Z"), now), false);
	assert.equal(isPastScheduledSend("not a date", now), true, "an unreadable time is refused");
	assert.equal(isPastScheduledSend("2026-10-13T14:05:30.000Z", now, 0), true, "the tolerance can be narrowed");
	assert.match(PAST_SCHEDULE_MESSAGE, /already passed/);
});

test("an accepted schedule still wins over the undo window", () => {
	const now = Date.parse("2026-10-13T14:05:42.000Z");
	const at = "2026-10-13T15:00:00.000Z";
	assert.equal(isPastScheduledSend(at, now), false);
	assert.deepEqual(resolveComposerSendTime(at, 10, now), { scheduledAt: at, undoUntil: null });
});
