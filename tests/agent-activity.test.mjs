import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-agent-activity-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/components/agent/agent-activity-utils.ts")],
	outfile: join(outDir, "agent-activity.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
});
const {
	actionLabel,
	actionTarget,
	activityUrl,
	initiatorLabel,
	pickActivityMailbox,
	reasonText,
	showsUndo,
	statusLabel,
	undoDisabledReason,
} = await import(pathToFileURL(join(outDir, "agent-activity.mjs")).href);

const NOW = new Date("2026-10-11T12:00:00.000Z");
const LATER = "2026-10-18T12:00:00.000Z";
const EARLIER = "2026-10-11T11:59:59.000Z";

const row = (extra = {}) => ({
	id: "aact-1",
	initiator: "agent",
	action: "create_draft",
	variant: "",
	undoOf: null,
	status: "applied",
	reason: "suggest_allows_create_draft",
	suggestionId: "sugg-1",
	messageId: "msg-1",
	after: { draftId: "draft-1" },
	undoUntil: LATER,
	undoneAt: null,
	createdAt: "2026-10-11T11:00:00.000Z",
	canUndo: true,
	subject: "Figures",
	draftAvailable: true,
	...extra,
});

test("initiators, statuses and actions read as plain words", () => {
	assert.equal(initiatorLabel("agent"), "Kite");
	assert.equal(initiatorLabel("user"), "User");
	assert.equal(statusLabel("applied"), "Done");
	assert.equal(statusLabel("blocked"), "Blocked");
	assert.equal(statusLabel("undone"), "Undone");
	assert.equal(actionLabel(row()), "Drafted a reply");
	assert.equal(actionLabel(row({ action: "dismiss" })), "Dismissed a suggestion");
	assert.equal(actionLabel(row({ action: "send_rsvp", variant: "declined" })), "Declined an invitation");
	assert.equal(actionLabel(row({ action: "dismiss", undoOf: "aact-0" })), "Undid: dismissed a suggestion");
	assert.equal(actionLabel(row({ action: "brand_new" })), "Brand new");
});

test("skip and block reasons are shown in plain words, never as bare codes", () => {
	assert.equal(reasonText("daily_limit"), "Paused: daily limit reached");
	assert.match(reasonText("spend_cap"), /spend cap/);
	assert.match(reasonText("kill_switch"), /turned off for this install/);
	assert.match(reasonText("external_provider_not_allowed"), /external AI provider is not allowed/);
	assert.match(reasonText("training_model_not_allowed"), /may train on your prompts and replies/);
	assert.match(reasonText("paused"), /paused for this mailbox/);
	assert.match(reasonText("rate_limited"), /rate limited/i);
	assert.match(reasonText("draft_guard"), /^Blocked: /);
	assert.equal(reasonText("suggest_allows_create_draft"), "Allowed in Suggest mode");
	assert.equal(reasonText("user_click"), "Chosen by a person");
	assert.equal(reasonText("some_future_code"), "Some future code");
	assert.equal(
		reasonText("The draft was already sent, so Kite kept it"),
		"The draft was already sent, so Kite kept it",
	);
	assert.equal(reasonText(null), null);
	assert.equal(reasonText(""), null);
});

test("the target opens the agent draft while it exists, otherwise the message", () => {
	assert.deepEqual(actionTarget(row()), { href: "/drafts/draft-1", label: "Draft reply: Figures" });
	assert.deepEqual(actionTarget(row({ status: "undone" })), { href: "/inbox/msg-1", label: "Figures" });
	assert.deepEqual(actionTarget(row({ status: "blocked", after: null, subject: null })), {
		href: "/inbox/msg-1",
		label: "(No subject)",
	});
	assert.deepEqual(actionTarget(row({ action: "move", after: { status: "spam" } })), {
		href: "/spam/msg-1",
		label: "Figures",
	});
	assert.equal(actionTarget(row({ action: "dismiss", messageId: null })), null);
});

test("a draft the viewer cannot open (discarded, deleted or someone else's) links to the source message", () => {
	assert.deepEqual(actionTarget(row({ draftAvailable: false })), { href: "/inbox/msg-1", label: "Figures" });
	assert.equal(actionTarget(row({ draftAvailable: false, messageId: null })), null);
	const sent = row({ draftAvailable: false, after: { draftId: "draft-1", sentMessageId: "sent-1" } });
	assert.deepEqual(actionTarget(sent), { href: "/sent/sent-1", label: "Sent reply: Figures" });
});

test("a sent agent draft links to the sent reply, never to the trashed draft", () => {
	const sent = row({ after: { draftId: "draft-1", sentMessageId: "sent 1" } });
	assert.deepEqual(actionTarget(sent), { href: "/sent/sent%201", label: "Sent reply: Figures" });
	assert.deepEqual(actionTarget({ ...sent, subject: "" }), {
		href: "/sent/sent%201",
		label: "Sent reply: (No subject)",
	});
	assert.doesNotMatch(actionTarget(sent).href, /\/drafts\//);
	assert.deepEqual(actionTarget(row({ action: "dismiss", after: { sentMessageId: "sent-1" } })), {
		href: "/inbox/msg-1",
		label: "Figures",
	});
});

test("Undo is enabled only for applied rows inside the undo window", () => {
	assert.equal(undoDisabledReason(row(), NOW), null);
	assert.match(undoDisabledReason(row({ status: "blocked", canUndo: false }), NOW), /Blocked/);
	assert.equal(undoDisabledReason(row({ status: "undone", canUndo: false }), NOW), "Already undone");
	assert.match(undoDisabledReason(row({ status: "failed", canUndo: false }), NOW), /Failed/);
	assert.match(undoDisabledReason(row({ status: "pending", canUndo: false }), NOW), /progress/);
	assert.match(undoDisabledReason(row({ undoUntil: EARLIER }), NOW), /window has passed/);
	assert.match(undoDisabledReason(row({ undoUntil: null }), NOW), /window has passed/);
	assert.match(undoDisabledReason(row({ canUndo: false }), NOW), /cannot be undone/);
	assert.equal(showsUndo(row()), true);
	assert.equal(showsUndo(row({ undoOf: "aact-0" })), false);
});

test("the page starts on the selected mailbox when the user has full access to it", () => {
	const mailboxes = [{ id: "a" }, { id: "b" }];
	assert.equal(pickActivityMailbox(mailboxes, "b"), "b");
	assert.equal(pickActivityMailbox(mailboxes, "elsewhere"), "a");
	assert.equal(pickActivityMailbox(mailboxes, null), "a");
	assert.equal(pickActivityMailbox([], "a"), null);
	assert.equal(activityUrl("mb 1"), "/api/agent/actions?mailboxId=mb%201");
});
