import assert from "node:assert/strict";
import test from "node:test";
import { serializeAgentToolOutput } from "../src/lib/agent/tool-history-utils.ts";

const email = (index) => ({
	id: `msg_${index}`,
	subject: `[GitHub] A fine-grained personal access token has expired ${index}`,
	from: '"GitHub" <noreply@github.com>',
	snippet: "Hey midego1, Your fine-grained personal access token has expired. If this token is still needed...",
});

test("small results are stored unchanged", () => {
	const output = { count: 3, query: "from:github.com" };
	assert.equal(serializeAgentToolOutput(output), JSON.stringify(output));
});

test("a large email list stays valid JSON and records how many emails were left out", () => {
	const emails = Array.from({ length: 200 }, (_, index) => email(index));
	const stored = serializeAgentToolOutput({ emails, nextCursor: "msg_last" }, 12_000);
	assert.ok(stored.length <= 12_000);
	const parsed = JSON.parse(stored);
	assert.equal(parsed.truncated, true);
	assert.equal(parsed.nextCursor, "msg_last");
	assert.equal(parsed.emails.length + parsed.omittedEmails, 200);
	assert.ok(parsed.emails.length > 0);
});

test("a proposal awaiting approval is kept whole so it can still be approved", () => {
	const emails = Array.from({ length: 200 }, (_, index) => email(index));
	const proposal = {
		action: "move_emails",
		status: "pending_approval",
		emailIds: emails.map((item) => item.id),
		destination: "archive",
		emails,
	};
	const stored = serializeAgentToolOutput(proposal, 12_000);
	assert.ok(stored.length > 12_000);
	assert.deepEqual(JSON.parse(stored), proposal);
});

test("long text and non-object results are shortened without breaking JSON", () => {
	const text = JSON.parse(serializeAgentToolOutput({ id: "msg_1", text: "x".repeat(50_000) }, 12_000));
	assert.equal(text.truncated, true);
	assert.ok(text.text.length < 50_000);
	const list = JSON.parse(
		serializeAgentToolOutput(
			Array.from({ length: 5000 }, (_, i) => i),
			12_000,
		),
	);
	assert.equal(list.truncated, true);
	assert.equal(typeof list.preview, "string");
});
