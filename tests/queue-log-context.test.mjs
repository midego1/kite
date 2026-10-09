import assert from "node:assert/strict";
import test from "node:test";
import { describeQueueMessage, queueMetric } from "../worker-utils.ts";
import { createLogger } from "../src/lib/logger.mjs";

const inbound = {
	from: "sender@example.com",
	to: "private@example.com",
	rawR2Key: "inbound/1700000000000-example_id.eml",
	headers: { subject: "Private subject" },
};

test("queue messages are described by kind without addresses or headers", () => {
	assert.deepEqual(describeQueueMessage(inbound), { kind: "inbound", rawR2Key: inbound.rawR2Key });
	assert.deepEqual(describeQueueMessage({ kind: "webhook.retry", deliveryId: "d1" }), { kind: "webhook_retry" });
	assert.deepEqual(describeQueueMessage({ kind: "email.scheduled", jobId: "j1" }), { kind: "outbound" });
	assert.deepEqual(describeQueueMessage({ kind: "agent.draft", jobId: "j1" }), { kind: "agent_draft" });
	assert.deepEqual(describeQueueMessage({ kind: "import.imap", jobId: "j1" }), { kind: "import" });
	assert.deepEqual(describeQueueMessage({ kind: "mailbox.purge", mailboxId: "m1" }), { kind: "mailbox_purge" });
	for (const value of [null, "text", 1, {}, { kind: "constructor" }, { kind: "private@example.com" }])
		assert.deepEqual(describeQueueMessage(value), { kind: "unknown" });
});

test("an unexpected raw key shape is left out of the context", () => {
	assert.deepEqual(describeQueueMessage({ ...inbound, rawR2Key: "inbound/private@example.com.eml" }), {
		kind: "inbound",
	});
	assert.deepEqual(describeQueueMessage({ ...inbound, rawR2Key: 42 }), { kind: "inbound" });
});

test("queue failure context survives redaction and carries no mail data", () => {
	const lines = [];
	const logger = createLogger("worker", { sink: (line) => lines.push(line) });
	const error = Object.assign(new Error("failed for private@example.com"), { code: "SQLITE_BUSY" });
	logger.error("queue.processing_failed", {
		queue: "kite-inbound",
		messageId: "6f1c0b7e2d",
		attempts: 2,
		...describeQueueMessage(inbound),
		error,
	});
	const entry = JSON.parse(lines[0]);
	assert.deepEqual(entry.fields, {
		queue: "kite-inbound",
		messageId: "6f1c0b7e2d",
		attempts: 2,
		kind: "inbound",
		rawR2Key: inbound.rawR2Key,
		error: { type: "Error", code: "SQLITE_BUSY" },
	});
	assert.doesNotMatch(lines[0], /example\.com|Private subject/);
});

test("inbound enqueue failure context survives redaction", () => {
	const lines = [];
	createLogger("worker", { sink: (line) => lines.push(JSON.parse(line)) }).error("inbound.enqueue_failed", {
		stage: "enqueue",
		rawSize: 2048,
		rawR2Key: inbound.rawR2Key,
		error: new Error("private"),
	});
	assert.deepEqual(lines[0].fields, {
		stage: "enqueue",
		rawSize: 2048,
		rawR2Key: inbound.rawR2Key,
		error: { type: "Error" },
	});
});

test("queue metrics carry kind, queue name and outcome only", () => {
	assert.deepEqual(queueMetric(inbound, "kite-inbound", "retry", 42, 3, "v1"), {
		event: "queue",
		service: "kite",
		name: "inbound",
		detail: "kite-inbound",
		outcome: "retry",
		durationMs: 42,
		attempts: 3,
		version: "v1",
	});
	assert.doesNotMatch(JSON.stringify(queueMetric(inbound, "q", "ack", 1, 1)), /@|Private|inbound\/1700/);
	assert.equal(queueMetric({ kind: "private@example.com" }, "q", "ack", 1, 1).name, "unknown");
});
