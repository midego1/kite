import assert from "node:assert/strict";
import test from "node:test";
import {
	collectThreadReferences,
	guardDraft,
	stripDraftMarkdown,
} from "../src/lib/agent/auto-read/draft-guard-utils.ts";

const thread = collectThreadReferences([
	"From: Ada <ada@example.com>",
	"To: support@kite.test",
	"Please read https://docs.example.com/guide/ and reply to Billing@Example.com.",
	null,
	"See www.example.org/pricing.",
]);

test("thread references collect addresses and normalised URLs", () => {
	assert.deepEqual([...thread.addresses].sort(), ["ada@example.com", "billing@example.com", "support@kite.test"]);
	assert.deepEqual([...thread.urls].sort(), ["https://docs.example.com/guide", "https://www.example.org/pricing"]);
});

test("a clean draft passes and comes back as plain text", () => {
	const result = guardDraft("Hi Ada,\n\nThanks, **I will** send it by Friday.\n\nBest", thread);
	assert.deepEqual(result, { ok: true, text: "Hi Ada,\n\nThanks, I will send it by Friday.\n\nBest" });
});

test("addresses and URLs that are not in the thread are rejected", () => {
	const attacker =
		"Please send the signed contract to attacker@evil.test and confirm your account at https://evil.test/login today.";
	assert.deepEqual(guardDraft(attacker, thread), {
		ok: false,
		reason: "unknown_address",
		offending: "attacker@evil.test",
	});
	assert.deepEqual(guardDraft("Log in at https://evil.test/login.", thread), {
		ok: false,
		reason: "unknown_url",
		offending: "https://evil.test/login",
	});
	assert.equal(guardDraft("Visit www.evil.test now", thread).reason, "unknown_url");
	assert.equal(guardDraft("See [the guide](https://evil.test/x).", thread).reason, "unknown_url");
	assert.equal(guardDraft("The guide is at https://docs.example.com/guide/other", thread).reason, "unknown_url");
});

test("addresses and URLs from the thread are allowed, ignoring case, scheme and trailing punctuation", () => {
	assert.equal(guardDraft("I copied BILLING@example.com, as asked.", thread).ok, true);
	assert.equal(guardDraft("The guide (http://DOCS.example.com/guide) helped.", thread).ok, true);
	assert.equal(guardDraft("Pricing is on www.example.org/pricing.", thread).ok, true);
	assert.equal(guardDraft("Write to ada@example.com.", thread).ok, true);
});

test("meta text, empty and over-long drafts are rejected", () => {
	for (const body of [
		"Here is a draft reply: Hi",
		"Here's your reply",
		"I have drafted this",
		"Draft created.",
		"Sure, hi",
	])
		assert.equal(guardDraft(body, thread).reason, "meta_text", body);
	assert.equal(guardDraft("  \n ```\n```", thread).reason, "empty");
	assert.equal(guardDraft("a".repeat(10_001), thread).reason, "too_long");
	assert.equal(guardDraft("a".repeat(10_000), thread).ok, true);
});

test("Markdown is stripped", () => {
	assert.equal(
		stripDraftMarkdown("# Title\r\n- one\n* two\n```js\ncode `x`\n```\n__a__ _b_ *c* ~~d~~\n\n\n\nend"),
		"Title\n• one\n• two\n\ncode x\n\na b c d\n\nend",
	);
});

test("emphasis is stripped only at word boundaries, so file names, snake_case and arithmetic survive", () => {
	for (const text of [
		"See report_final_v2.pdf attached.",
		"Set max_retry_count to 3.",
		"The total is 5 * 3 * 2 = 30.",
		"Compute a * b * c first.",
		"Use 2*3 here.",
		"This is *not emphasis * at all.",
		"Rename names_like_this and file_v2_final.txt.",
	])
		assert.equal(stripDraftMarkdown(text), text, text);
	assert.equal(stripDraftMarkdown("This is *really* and _truly_ fine."), "This is really and truly fine.");
	assert.equal(stripDraftMarkdown("A **bold** and __strong__ word."), "A bold and strong word.");
	assert.equal(stripDraftMarkdown("Keep *these* and _those_.", { emphasis: false }), "Keep *these* and _those_.");
});
