import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

// The reply's body (spec §9) carries only Kite's own links and labels, never the model's or the conversation's text.

const { assistantReplyBody, assistantConversationPath, absoluteAppUrl } = await bundleModules(
	"kite-assistant-email-reply-",
	[["assistantReplyBody, assistantConversationPath, absoluteAppUrl", "src/lib/agent/email/reply-utils.ts"]],
);

test("the reply names only the conversation link and the caller's links, never model text", () => {
	const { text, html } = assistantReplyBody({
		appUrl: "https://mail.example.com",
		conversationId: "conv-1",
		links: [{ label: "Review the draft to jan@example.net", url: "https://mail.example.com/agent/review/abc" }],
	});
	assert.match(text, /^Kite has answered your request\.$/m);
	assert.match(text, /https:\/\/mail\.example\.com\/inbox\?assistant=conv-1/);
	assert.match(text, /Review the draft to jan@example\.net: https:\/\/mail\.example\.com\/agent\/review\/abc/);
	assert.match(html, /<a href="https:\/\/mail\.example\.com\/inbox\?assistant=conv-1">/);
	assert.match(html, /Review the draft to jan@example\.net/);
});

test("a refusal or a failure replaces the intro with the caller's fixed note, still no model text", () => {
	const { text } = assistantReplyBody({
		appUrl: "https://mail.example.com",
		conversationId: "conv-1",
		note: "Kite could not answer: the daily limit was reached.",
	});
	assert.match(text, /^Kite could not answer: the daily limit was reached\.$/m);
	assert.ok(!text.includes("has answered your request"));
});

test("without a configured public origin, the link is omitted instead of a dead relative URL", () => {
	const { text, html } = assistantReplyBody({ appUrl: null, conversationId: "conv-1" });
	assert.ok(!text.includes("/inbox?assistant="));
	assert.match(text, /look for this request in the assistant panel/);
	assert.ok(!html.includes("/inbox?assistant="));
});

test("assistantConversationPath and absoluteAppUrl build the same URL the reply uses", () => {
	assert.equal(assistantConversationPath("conv-1"), "/inbox?assistant=conv-1");
	assert.equal(
		absoluteAppUrl("https://mail.example.com/", "/inbox?assistant=conv-1"),
		"https://mail.example.com/inbox?assistant=conv-1",
	);
	assert.equal(absoluteAppUrl(undefined, "/inbox?assistant=conv-1"), null);
});

test("html escapes a label and url so a crafted conversation title cannot break the markup", () => {
	const { html } = assistantReplyBody({
		appUrl: "https://mail.example.com",
		conversationId: "conv-1",
		links: [{ label: "<img onerror=alert(1)>", url: "https://mail.example.com/agent/review/abc" }],
	});
	assert.ok(!html.includes("<img"));
	assert.match(html, /&lt;img onerror=alert\(1\)&gt;/);
});
