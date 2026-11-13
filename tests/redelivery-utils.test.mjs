import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

// Recognising a sender's retry of a message Kite already stored (src/lib/email/redelivery.ts), and the inbound queue
// message limit. Invented mail only.

const {
	messageBody,
	toHex,
	fingerprintInput,
	REDELIVERY_WINDOW_MS,
	INBOUND_QUEUE_PAYLOAD_TOO_LARGE_REASON,
	inboundQueuePayloadTooLarge,
} = await bundleModules("kite-redelivery-utils-", [
	["messageBody, toHex, fingerprintInput, REDELIVERY_WINDOW_MS", "src/lib/email/redelivery-utils.ts"],
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

test("the fingerprint input keeps Date, Subject and the body digest apart", () => {
	assert.equal(toHex(new Uint8Array([0, 15, 255])), "000fff");
	const base = fingerprintInput(["Mon, 2 Nov 2026 10:00:00 +0000"], ["Backup done"], "ab");
	assert.notEqual(base, fingerprintInput(["Mon, 2 Nov 2026 11:00:00 +0000"], ["Backup done"], "ab"));
	assert.notEqual(base, fingerprintInput(["Mon, 2 Nov 2026 10:00:00 +0000"], ["Backup failed"], "ab"));
	assert.notEqual(base, fingerprintInput(["Mon, 2 Nov 2026 10:00:00 +0000"], ["Backup done"], "cd"));
	// A header block that could not be read whole is not the same as one without the field.
	assert.notEqual(fingerprintInput(null, [], "ab"), fingerprintInput([], [], "ab"));
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
	// One character above U+00FF may make the queue store the whole string as UTF-16, two bytes per character.
	assert.equal(inboundQueuePayloadTooLarge(payload("x".repeat(70 * 1024))), false);
	assert.equal(inboundQueuePayloadTooLarge(payload(`${"x".repeat(70 * 1024)}€`)), true);
	assert.match(INBOUND_QUEUE_PAYLOAD_TOO_LARGE_REASON, /^Message rejected:/);
});
