import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

// Recognising a sender's retry of a message Kite already stored (src/lib/email/redelivery.ts), and the inbound queue
// message limit. Invented mail only.

const {
	messageBody,
	sameBytes,
	REDELIVERY_WINDOW_MS,
	INBOUND_QUEUE_PAYLOAD_TOO_LARGE_REASON,
	inboundQueuePayloadTooLarge,
} = await bundleModules("kite-redelivery-utils-", [
	["messageBody, sameBytes, REDELIVERY_WINDOW_MS", "src/lib/email/redelivery-utils.ts"],
	["INBOUND_QUEUE_PAYLOAD_TOO_LARGE_REASON, inboundQueuePayloadTooLarge", "src/lib/email/inbound-queue-utils.ts"],
]);

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const body = (text) => decoder.decode(messageBody(encoder.encode(text)));

test("the body starts after the first empty line, whichever line ends the message uses", () => {
	assert.equal(body("Subject: hi\r\nX-A: 1\r\n\r\nHello\r\n\r\nthere"), "Hello\r\n\r\nthere");
	assert.equal(body("Subject: hi\n\nHello"), "Hello");
	// Header fields a hop added at the top leave the body as it was.
	assert.equal(body("Received: by mx\r\nSubject: hi\r\n\r\nHello"), body("Subject: hi\r\n\r\nHello"));
	assert.equal(body("Subject: no body at all\r\n"), "");
	assert.equal(body(""), "");
});

test("sameBytes compares length and every byte", () => {
	assert.equal(sameBytes(encoder.encode("abc"), encoder.encode("abc")), true);
	assert.equal(sameBytes(encoder.encode("abc"), encoder.encode("abd")), false);
	assert.equal(sameBytes(encoder.encode("abc"), encoder.encode("ab")), false);
});

test("retries are recognised for longer than senders keep retrying", () => {
	assert.ok(REDELIVERY_WINDOW_MS >= 5 * 24 * 60 * 60 * 1000);
});

test("a queue message over the limit is refused, one within it is not", () => {
	const payload = (padding) => ({
		from: "a@b.test",
		to: "c@d.test",
		rawR2Key: "inbound/1-x.eml",
		headers: { x: padding },
	});
	assert.equal(inboundQueuePayloadTooLarge(payload("x".repeat(1000))), false);
	assert.equal(inboundQueuePayloadTooLarge(payload("x".repeat(120 * 1024))), true);
	// Bytes count, not characters: a multi-byte header value fills the limit sooner.
	assert.equal(inboundQueuePayloadTooLarge(payload("é".repeat(60 * 1024))), true);
	assert.match(INBOUND_QUEUE_PAYLOAD_TOO_LARGE_REASON, /^Message rejected:/);
});
