import assert from "node:assert/strict";
import test from "node:test";
import { settleWithin } from "../src/lib/contacts/spoofed-sender-utils.ts";

test("a lookup that finishes in time keeps its value", async () => {
	assert.equal(await settleWithin(Promise.resolve("maya@trusted.test"), 200, null), "maya@trusted.test");
});

test("a lookup that outlasts the limit gives the fallback instead of holding the message back", async () => {
	const slow = new Promise((resolve) => setTimeout(() => resolve("late"), 300));
	const startedAt = Date.now();
	assert.equal(await settleWithin(slow, 30, null), null);
	assert.ok(Date.now() - startedAt < 250, "did not wait for the slow lookup");
});

test("a failing lookup gives the fallback", async () => {
	assert.equal(await settleWithin(Promise.reject(new Error("D1 down")), 200, null), null);
});

test("the timeout callback runs when the limit wins, not for a value or a rejection", async () => {
	let timeouts = 0;
	const onTimeout = () => (timeouts += 1);
	await settleWithin(Promise.resolve(1), 100, null, onTimeout);
	await settleWithin(Promise.reject(new Error("down")), 100, null, onTimeout);
	assert.equal(timeouts, 0);
	await settleWithin(new Promise((resolve) => setTimeout(resolve, 300)), 20, null, onTimeout);
	assert.equal(timeouts, 1);
});
