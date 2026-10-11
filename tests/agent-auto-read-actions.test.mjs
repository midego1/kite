import assert from "node:assert/strict";
import test from "node:test";
import {
	ACTION_REGISTRY,
	DEFAULT_UNDO_WINDOW_MS,
	actionIds,
	canOfferUndo,
	getActionMeta,
	getUndoRule,
	inverseActionFor,
	isStalePending,
	parseActionState,
	toActivityAction,
	undoRefusal,
	undoUntilFor,
	userExecuteRefusal,
} from "../src/lib/agent/auto-read/actions-utils.ts";

const now = new Date("2026-10-11T12:00:00.000Z");
const later = new Date(now.getTime() + 60_000);
const full = { canManage: true, canSendOnBehalf: true };
const sendOnly = { canManage: false, canSendOnBehalf: true };
const none = { canManage: false, canSendOnBehalf: false };
const applied = (values = {}) => ({
	action: "dismiss",
	variant: "",
	status: "applied",
	undoUntil: later,
	actingUserId: "owner",
	...values,
});

test("the registry covers dismiss, drafts, spam moves and the calendar actions with a 7-day undo window", () => {
	assert.deepEqual(Object.keys(ACTION_REGISTRY).sort(), [
		"create_draft",
		"create_event",
		"delete_event",
		"dismiss",
		"move",
		"send_rsvp",
	]);
	assert.deepEqual(ACTION_REGISTRY.send_rsvp.variants, ["accepted", "declined"]);
	assert.equal(inverseActionFor({ action: "create_event", variant: "" }), "delete_event");
	assert.equal(inverseActionFor({ action: "create_event", variant: "update" }), "create_event");
	assert.equal(inverseActionFor({ action: "delete_event", variant: "" }), "create_event");
	assert.deepEqual(ACTION_REGISTRY.move.variants, ["spam"]);
	assert.equal(getUndoRule(ACTION_REGISTRY.move, "spam").windowMs, DEFAULT_UNDO_WINDOW_MS);
	assert.equal(getActionMeta("send_reply"), null);
	assert.equal(getUndoRule(ACTION_REGISTRY.dismiss, "").windowMs, DEFAULT_UNDO_WINDOW_MS);
	assert.equal(
		undoUntilFor(ACTION_REGISTRY.dismiss, "", now).toISOString(),
		new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
	);
	assert.equal(getUndoRule(ACTION_REGISTRY.dismiss, "undo:act-1"), null);
	assert.equal(undoUntilFor(ACTION_REGISTRY.dismiss, "undo:act-1", now), null);
});

test("undo rules can differ per variant, and a null rule makes a variant permanent", () => {
	const meta = {
		executePermission: "send_on_behalf",
		variants: ["accepted", "declined"],
		undo: {
			accepted: { windowMs: 1000, permission: "send_on_behalf", actingUserOnly: true, inverseAction: "send_rsvp" },
			declined: null,
		},
	};
	assert.equal(getUndoRule(meta, "accepted").windowMs, 1000);
	assert.equal(getUndoRule(meta, "declined"), null);
	assert.equal(getUndoRule(meta, "other"), null);
	assert.equal(userExecuteRefusal(meta, "maybe", full), "variant_not_supported");
	assert.equal(userExecuteRefusal(meta, "accepted", none), "missing_send_on_behalf");
	assert.equal(userExecuteRefusal(meta, "accepted", sendOnly), null);
});

test("user clicks need the action's permission", () => {
	assert.equal(userExecuteRefusal(null, "", full), "action_not_supported");
	assert.equal(userExecuteRefusal(ACTION_REGISTRY.dismiss, "", sendOnly), "missing_manage");
	assert.equal(userExecuteRefusal(ACTION_REGISTRY.dismiss, "", full), null);
	assert.equal(userExecuteRefusal(ACTION_REGISTRY.create_draft, "", sendOnly), null);
});

test("pending rows become stale after ten minutes", () => {
	assert.equal(isStalePending(new Date(now.getTime() - 10 * 60_000), now), false);
	assert.equal(isStalePending(new Date(now.getTime() - 10 * 60_000 - 1), now), true);
});

test("undo is refused when not applied, expired, unsupported or missing the permission", () => {
	assert.equal(undoRefusal(applied(), "owner", full, now), null);
	assert.equal(undoRefusal(applied({ action: "send_reply" }), "owner", full, now).status, 409);
	assert.equal(undoRefusal(applied({ variant: "undo:act-1" }), "owner", full, now).status, 409);
	for (const status of ["undone", "failed", "blocked", "pending"])
		assert.equal(undoRefusal(applied({ status }), "owner", full, now).status, 409, status);
	assert.equal(undoRefusal(applied({ undoUntil: now }), "owner", full, now).status, 409);
	assert.equal(undoRefusal(applied({ undoUntil: null }), "owner", full, now).status, 409);
	assert.equal(undoRefusal(applied(), "owner", sendOnly, now).status, 403);
	const draft = applied({ action: "create_draft" });
	assert.equal(undoRefusal(draft, "owner", full, now), null);
	assert.equal(undoRefusal(draft, "manager", full, now).status, 403);
	assert.equal(undoRefusal(draft, "owner", none, now).status, 403);
});

test("inverse rows default to the original action type", () => {
	assert.equal(inverseActionFor({ action: "dismiss", variant: "" }), "dismiss");
	assert.equal(inverseActionFor({ action: "send_reply", variant: "" }), "send_reply");
});

test("action state parses objects only and exposes string ids", () => {
	assert.equal(parseActionState(null), null);
	assert.equal(parseActionState("not json"), null);
	assert.equal(parseActionState("[1]"), null);
	assert.deepEqual(parseActionState('{"draftId":"msg_1","n":2}'), { draftId: "msg_1", n: 2 });
	assert.deepEqual(actionIds({ draftId: "msg_1", n: 2 }), { draftId: "msg_1" });
	assert.deepEqual(actionIds(null), {});
});

test("activity rows offer undo only while applied and inside the window", () => {
	const row = {
		id: "act-1",
		mailboxId: "mailbox-a",
		suggestionId: "sugg-1",
		messageId: "msg-1",
		jobId: null,
		initiator: "user",
		actingUserId: "owner",
		autonomy: null,
		action: "dismiss",
		variant: "",
		status: "applied",
		before: '{"status":"open"}',
		after: '{"status":"dismissed"}',
		reason: "user_click",
		undoUntil: later,
		undoneAt: null,
		undoneByUserId: null,
		createdAt: now,
		updatedAt: now,
	};
	const item = toActivityAction(row, now);
	assert.equal(item.canUndo, true);
	assert.equal(item.undoOf, null);
	assert.equal("before" in item, false);
	assert.deepEqual(item.after, { status: "dismissed" });
	assert.equal(item.undoUntil, later.toISOString());
	assert.equal(toActivityAction(row, later).canUndo, false);
	const inverse = toActivityAction(
		{ ...row, variant: "undo:act-0", undoUntil: null, undoneAt: now, undoneByUserId: "owner" },
		now,
	);
	assert.equal(inverse.undoOf, "act-0");
	assert.equal(inverse.variant, "");
	assert.equal(inverse.canUndo, false);
	assert.equal(inverse.undoneAt, now.toISOString());
	assert.equal(canOfferUndo({ ...row, action: "send_reply" }, now), false);
	assert.equal(canOfferUndo({ ...row, status: "undone" }, now), false);
});
