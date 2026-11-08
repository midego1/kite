import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

const {
	hasAssistantLoopHeader,
	hasSingleFromAddress,
	isEmptyEnvelopeSender,
	isNonRepliableSender,
	isWithinReplayWindow,
	normalizedFromAddress,
	normalizeMessageId,
	senderHeaderNamesOther,
	stripQuotedReplyText,
} = await bundleModules("kite-assistant-email-guards-", [
	[
		"hasAssistantLoopHeader, hasSingleFromAddress, isEmptyEnvelopeSender, isNonRepliableSender, isWithinReplayWindow, normalizedFromAddress, normalizeMessageId, senderHeaderNamesOther, stripQuotedReplyText",
		"src/lib/agent/email/guards-utils.ts",
	],
]);

test("every header section 6 names drops the request", () => {
	const from = "jan@example.com";
	assert.equal(hasAssistantLoopHeader(from, { "auto-submitted": "auto-replied" }), true);
	assert.equal(hasAssistantLoopHeader(from, { "auto-submitted": "no" }), false);
	assert.equal(hasAssistantLoopHeader(from, { precedence: "bulk" }), true);
	assert.equal(hasAssistantLoopHeader(from, { precedence: "list" }), true);
	assert.equal(hasAssistantLoopHeader(from, { "list-id": "<news.example.com>" }), true);
	assert.equal(hasAssistantLoopHeader(from, { "list-unsubscribe": "<mailto:x@example.com>" }), true);
	assert.equal(hasAssistantLoopHeader(from, { "x-auto-response-suppress": "All" }), true);
	assert.equal(hasAssistantLoopHeader(from, { "x-autoreply": "1" }), true);
	assert.equal(hasAssistantLoopHeader(from, { "x-autorespond": "1" }), true);
	assert.equal(hasAssistantLoopHeader(from, { "x-kite-assistant": "1" }), true);
	assert.equal(hasAssistantLoopHeader(from, { "content-type": "multipart/report; report-type=delivery-status" }), true);
	assert.equal(hasAssistantLoopHeader(from, {}), false);
	assert.equal(hasAssistantLoopHeader("mailer-daemon@example.com", {}), true);
	assert.equal(hasAssistantLoopHeader("postmaster@example.com", {}), true);
});

test("isEmptyEnvelopeSender catches a bounce and nothing else", () => {
	assert.equal(isEmptyEnvelopeSender("<>"), true);
	assert.equal(isEmptyEnvelopeSender(""), true);
	assert.equal(isEmptyEnvelopeSender(null), true);
	assert.equal(isEmptyEnvelopeSender(undefined), true);
	assert.equal(isEmptyEnvelopeSender("jan@example.com"), false);
});

test("hasSingleFromAddress requires exactly one address", () => {
	assert.equal(hasSingleFromAddress("Jan <jan@example.com>"), true);
	assert.equal(hasSingleFromAddress("jan@example.com, ivy@example.com"), false);
	assert.equal(hasSingleFromAddress(null), false);
	assert.equal(hasSingleFromAddress(""), false);
});

test("senderHeaderNamesOther only trips on a different address", () => {
	assert.equal(senderHeaderNamesOther(null, "jan@example.com"), false);
	assert.equal(senderHeaderNamesOther("Jan <jan@example.com>", "jan@example.com"), false);
	assert.equal(senderHeaderNamesOther("evil@attacker.test", "jan@example.com"), true);
});

test("isNonRepliableSender matches mailer-daemon, postmaster and no-reply addresses", () => {
	for (const address of [
		"mailer-daemon@example.com",
		"postmaster@example.com",
		"no-reply@example.com",
		"noreply@example.com",
		"do-not-reply@example.com",
	])
		assert.equal(isNonRepliableSender(address), true, address);
	assert.equal(isNonRepliableSender("jan@example.com"), false);
});

test("isWithinReplayWindow enforces the 24h-old, 1h-future window and fails closed without a date", () => {
	const now = new Date("2026-01-02T00:00:00Z");
	assert.equal(isWithinReplayWindow(new Date("2026-01-01T00:00:01Z"), now), true);
	assert.equal(isWithinReplayWindow(new Date("2025-12-31T23:59:59Z"), now), false);
	assert.equal(isWithinReplayWindow(new Date("2026-01-02T00:59:59Z"), now), true);
	assert.equal(isWithinReplayWindow(new Date("2026-01-02T01:00:01Z"), now), false);
	assert.equal(isWithinReplayWindow(null, now), false);
	assert.equal(isWithinReplayWindow(new Date(NaN), now), false);
});

test("normalizedFromAddress and normalizeMessageId are simple and case-insensitive", () => {
	assert.equal(normalizedFromAddress("Jan <Jan@Example.com>"), "jan@example.com");
	assert.equal(normalizeMessageId(" <REQ-1@Example.com> "), "req-1@example.com");
	assert.equal(normalizeMessageId(null), null);
	assert.equal(normalizeMessageId(""), null);
});

test("stripQuotedReplyText cuts at the first quote introduction, and leaves plain text whole", () => {
	assert.equal(
		stripQuotedReplyText(
			"Thanks, that works.\n\nOn Mon, Jan 5, 2026 at 9:00 AM Jan <jan@example.com> wrote:\n> Tuesday?",
		),
		"Thanks, that works.",
	);
	assert.equal(
		stripQuotedReplyText("Sounds good.\n\n----- Original Message -----\nFrom: Jan\nTuesday?"),
		"Sounds good.",
	);
	assert.equal(stripQuotedReplyText("Sounds good.\n\n> Tuesday?\n> Does that work?"), "Sounds good.");
	assert.equal(
		stripQuotedReplyText("No quote marker here, just > a lone one."),
		"No quote marker here, just > a lone one.",
	);
});
