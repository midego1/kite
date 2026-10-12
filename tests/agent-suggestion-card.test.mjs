import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-agent-suggestion-card-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/components/agent/suggestion-card-utils.ts")],
	outfile: join(outDir, "suggestion-card.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
});
const {
	cardSections,
	hasCardContent,
	newPhishingWarnings,
	pauseEnd,
	pauseUndoValue,
	phishingReasonTexts,
	replyStatusText,
	suggestionCardUrl,
	summaryText,
	whyDetails,
} = await import(pathToFileURL(join(outDir, "suggestion-card.mjs")).href);

const item = (id, kind, extra = {}) => ({
	id,
	kind,
	mailboxId: "mb-1",
	messageId: "msg-1",
	threadId: "thread-1",
	status: "open",
	title: `${kind} ${id}`,
	payload: {},
	draftId: null,
	model: null,
	createdAt: "2026-10-11T00:00:00.000Z",
	...extra,
});

test("the card lists the whole conversation, or the message alone without a thread", () => {
	assert.equal(suggestionCardUrl("msg-1", "thread 1"), "/api/agent/suggestions?status=open&threadId=thread+1");
	assert.equal(suggestionCardUrl("msg-1", null), "/api/agent/suggestions?status=open&messageId=msg-1");
});

test("the card shows the newest summary and one block per kind, phishing before reply", () => {
	const sections = cardSections(
		[
			item("r2", "reply"),
			item("s2", "summary", { payload: { text: "Newest" } }),
			item("p1", "phishing", { messageId: "msg-0" }),
			item("r1", "reply"),
			item("s1", "summary", { payload: { text: "Older" } }),
			item("t1", "task"),
		],
		"mb-1",
	);
	assert.equal(sections.summary.id, "s2");
	assert.deepEqual(
		sections.blocks.map((block) => block.id),
		["p1", "r2"],
	);
	assert.equal(hasCardContent(sections), true);
});

test("closed suggestions and other mailboxes' suggestions leave the card empty", () => {
	const sections = cardSections(
		[item("r1", "reply", { status: "superseded" }), item("s1", "summary", { mailboxId: "mb-2" })],
		"mb-1",
	);
	assert.deepEqual(sections, { summary: null, blocks: [], answered: null });
	assert.equal(hasCardContent(sections), false);
	assert.equal(hasCardContent(cardSections([item("s1", "summary")], null)), false);
});

test("summary text falls back to empty for a malformed payload", () => {
	assert.equal(summaryText(item("s1", "summary", { payload: { text: "Hello" } })), "Hello");
	assert.equal(summaryText(item("s1", "summary", { payload: { text: 3 } })), "");
});

test("Why? explains the policy reason and names the model", () => {
	assert.deepEqual(whyDetails(item("r1", "reply", { payload: { reason: "needs_reply" }, model: "fake-triage" })), {
		reason: "The message asks you something that needs an answer.",
		model: "Read by fake-triage.",
	});
	const unknown = whyDetails(item("p1", "phishing", { payload: { reason: "something_new" } }));
	assert.equal(unknown.reason, "Kite's rules for this mailbox suggested this.");
	assert.equal(unknown.model, "Found by Kite's rules, without a model.");
	assert.match(whyDetails(item("s1", "summary", { payload: { reason: "long_thread" } })).reason, /summarised/);
});

test("phishing reasons read in plain words, deterministic ones first, without repeats", () => {
	const texts = phishingReasonTexts(
		item("p1", "phishing", {
			payload: {
				reasons: [
					"displayed_link_mismatch",
					"suspicious_verdict",
					"ip_address_url",
					"punycode_url",
					"spf_failed",
					"dkim_failed",
					"dmarc_failed",
					"display_name_spoof",
					"credential_request",
					"payment_change",
					"urgency_pressure",
					"spoofed_identity",
					"unexpected_attachment",
					"model_flagged",
				],
			},
		}),
	);
	assert.equal(texts.length, 14);
	assert.equal(texts[0], "A link shows one web address but opens a different one.");
	assert.match(texts[4], /SPF failed/);
	assert.match(texts[7], /name of one of your contacts/);
	for (const text of texts) assert.doesNotMatch(text, /_/);
	assert.deepEqual(phishingReasonTexts(item("p1", "phishing", { payload: { reasons: ["new_one", "toString", 4] } })), [
		"Kite found another warning sign.",
	]);
	assert.deepEqual(phishingReasonTexts(item("p1", "phishing", { payload: {} })), []);
});

test("a pause lasts 24 hours from the click", () => {
	assert.equal(pauseEnd(new Date("2026-10-11T08:00:00.000Z")), "2026-10-12T08:00:00.000Z");
});

test("Undo of a card Pause restores an earlier pause that is still running, otherwise none", () => {
	const now = new Date("2026-10-11T08:00:00.000Z");
	assert.equal(pauseUndoValue("2026-10-11T22:00:00.000Z", now), "2026-10-11T22:00:00.000Z");
	assert.equal(pauseUndoValue("2026-10-11T07:00:00.000Z", now), null);
	assert.equal(pauseUndoValue(now.toISOString(), now), null);
	assert.equal(pauseUndoValue(null, now), null);
	assert.equal(pauseUndoValue(undefined, now), null);
	assert.equal(pauseUndoValue("not a date", now), null);
});

test("only phishing warnings that appear for the open message while it is open are new", () => {
	const first = newPhishingWarnings([item("p1", "phishing"), item("r1", "reply")], "msg-1", null);
	assert.deepEqual([...first.known], ["p1"]);
	assert.deepEqual(first.fresh, []);
	const later = newPhishingWarnings(
		[
			item("p2", "phishing"),
			item("p1", "phishing"),
			item("p3", "phishing", { messageId: "msg-0" }),
			item("p4", "phishing", { status: "accepted" }),
		],
		"msg-1",
		first.known,
	);
	assert.deepEqual(
		later.fresh.map((warning) => warning.id),
		["p2"],
	);
	assert.deepEqual(newPhishingWarnings([item("p2", "phishing")], "msg-1", later.known).fresh, []);
});

test("the reply line tells a non-reviewer that a draft exists without offering it", () => {
	assert.equal(
		replyStatusText({ draftId: "d", canReviewDraft: true }),
		"Kite drafted a reply. Review it before you send.",
	);
	assert.equal(
		replyStatusText({ draftId: "d", canReviewDraft: false }),
		"Kite drafted a reply. It is in the reviewer's Drafts.",
	);
	assert.equal(replyStatusText({ draftId: null, canReviewDraft: false }), "The drafted reply is gone.");
});
