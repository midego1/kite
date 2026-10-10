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
const { cardSections, hasCardContent, suggestionCardUrl, summaryText, whyDetails } = await import(
	pathToFileURL(join(outDir, "suggestion-card.mjs")).href
);

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
	assert.deepEqual(sections, { summary: null, blocks: [] });
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
