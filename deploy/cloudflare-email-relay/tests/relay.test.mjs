import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import nodeTest from "node:test";

const test = process.env.KITE_TEST_DISCOVERY === "1" ? (name) => nodeTest(name, { skip: true }, () => {}) : nodeTest;
import relay from "../src/index.ts";

const env = { KITE_URL: "https://kite.example/", INBOUND_WEBHOOK_SECRET: "test-only-secret" };
const mime = "From: sender@example.com\r\nTo: inbox@example.com\r\nSubject: Relay test\r\n\r\nHello";
function message(overrides = {}) {
	const rejections = [],
		forwards = [];
	return {
		from: "sender@example.com",
		to: "inbox@example.com",
		rawSize: Buffer.byteLength(mime),
		raw: new Response(mime).body,
		headers: new Headers({ subject: "Relay test" }),
		setReject: (reason) => rejections.push(reason),
		forward: async (destination, headers) => forwards.push({ destination, headers }),
		rejections,
		forwards,
		...overrides,
	};
}

test("stores mail through the real handler with a verifiable envelope-bound HMAC", async (t) => {
	const msg = message();
	t.mock.method(globalThis, "fetch", async (url, options) => {
		assert.equal(url, "https://kite.example/api/inbound");
		assert.equal(options.method, "POST");
		assert.equal(options.headers["Content-Type"], "message/rfc822");
		assert.equal(options.headers["X-Kite-From"], msg.from);
		assert.equal(options.headers["X-Kite-To"], msg.to);
		assert.deepEqual(JSON.parse(options.headers["X-Kite-Headers"]), { subject: "Relay test" });
		assert.equal(Buffer.from(options.body).toString(), mime);
		const signature = createHmac("sha256", env.INBOUND_WEBHOOK_SECRET)
			.update(`${msg.from}\n${msg.to}\n`)
			.update(mime)
			.digest("hex");
		assert.equal(options.headers["X-Kite-Signature"], signature);
		return Response.json({ action: "store", forwardTo: null });
	});
	await relay.email(msg, env);
	assert.deepEqual(msg.rejections, []);
	assert.deepEqual(msg.forwards, []);
});

test("a relay deployed before the rename still reads its MAILFLARE_URL secret", async (t) => {
	const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({ action: "store", forwardTo: null }));
	const msg = message();
	await relay.email(msg, { MAILFLARE_URL: "https://legacy.example", INBOUND_WEBHOOK_SECRET: "test-only-secret" });
	assert.equal(fetch.mock.calls[0].arguments[0], "https://legacy.example/api/inbound");
	assert.deepEqual(msg.rejections, []);
});

test("a relay without a server URL rejects with a retry hint", async (t) => {
	t.mock.method(console, "error", () => {});
	const fetch = t.mock.method(globalThis, "fetch", () => {
		throw new Error("must not fetch");
	});
	const msg = message();
	await relay.email(msg, { INBOUND_WEBHOOK_SECRET: "test-only-secret" });
	assert.deepEqual(msg.rejections, ["Kite is temporarily unavailable, please retry"]);
	assert.equal(fetch.mock.callCount(), 0);
});

test("oversized mail is rejected before calling the receiving server", async (t) => {
	const fetch = t.mock.method(globalThis, "fetch", () => {
		throw new Error("must not fetch");
	});
	const msg = message({ rawSize: 25 * 1024 * 1024 + 1 });
	await relay.email(msg, env);
	assert.match(msg.rejections[0], /25 MiB/);
	assert.equal(fetch.mock.callCount(), 0);
});

test("server size rejection is preserved", async (t) => {
	t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 413 }));
	const msg = message();
	await relay.email(msg, env);
	assert.match(msg.rejections[0], /too large/);
});

test("routing rejection uses the server's reason and never forwards", async (t) => {
	t.mock.method(globalThis, "fetch", async () => Response.json({ action: "reject", reason: "Blocked by rule" }));
	const msg = message();
	await relay.email(msg, env);
	assert.deepEqual(msg.rejections, ["Blocked by rule"]);
	assert.deepEqual(msg.forwards, []);
});

for (const action of ["forward", "store"]) {
	test(`${action} decision forwards with the server-provided loop-prevention headers`, async (t) => {
		t.mock.method(globalThis, "fetch", async () =>
			Response.json({ action, forwardTo: "team@example.com", forwardHeaders: { "X-Kite-Forwarded": "1" } }),
		);
		const msg = message();
		await relay.email(msg, env);
		assert.equal(msg.forwards.length, 1);
		assert.equal(msg.forwards[0].destination, "team@example.com");
		assert.equal(msg.forwards[0].headers.get("X-Kite-Forwarded"), "1");
		assert.deepEqual(msg.rejections, []);
	});
}

for (const [label, respond] of [
	[
		"network failure",
		async () => {
			throw new Error("network failed");
		},
	],
	["server error", async () => new Response(null, { status: 500 })],
	["invalid JSON", async () => new Response("invalid")],
]) {
	test(`${label} rejects with a retry hint and emits a structured log without mail or secrets`, async (t) => {
		const lines = [];
		t.mock.method(console, "error", (line) => lines.push(JSON.parse(line)));
		t.mock.method(globalThis, "fetch", respond);
		const msg = message();
		await relay.email(msg, env);
		assert.deepEqual(msg.rejections, ["Kite is temporarily unavailable, please retry"]);
		assert.equal(lines[0].event, "relay.request_failed");
		assert.equal(lines[0].component, "email-relay");
		assert.doesNotMatch(JSON.stringify(lines), /sender@example|test-only-secret|Subject:/);
	});
}

test("a forwarding failure is logged without rejecting already stored mail", async (t) => {
	const lines = [];
	t.mock.method(console, "error", (line) => lines.push(JSON.parse(line)));
	t.mock.method(globalThis, "fetch", async () => Response.json({ action: "store", forwardTo: "private@example.com" }));
	const msg = message({
		forward: async () => {
			throw new Error("private@example.com failed");
		},
	});
	await relay.email(msg, env);
	assert.deepEqual(msg.rejections, []);
	assert.equal(lines[0].event, "relay.forward_failed");
	assert.doesNotMatch(JSON.stringify(lines), /private@example/);
});

test("relay health is a side-effect-free liveness check and other methods/paths are rejected", async (t) => {
	const fetch = t.mock.method(globalThis, "fetch", () => {
		throw new Error("must not contact receiver");
	});
	const response = await relay.fetch(new Request("https://relay.example/health"));
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { status: "ok", service: "kite-email-relay" });
	assert.equal(response.headers.get("Cache-Control"), "no-store");
	assert.equal((await relay.fetch(new Request("https://relay.example/other"))).status, 404);
	assert.equal((await relay.fetch(new Request("https://relay.example/health", { method: "POST" }))).status, 404);
	assert.equal(fetch.mock.callCount(), 0);
});

test("relay receiving-server call has a cancellation signal and trace context", async (t) => {
	t.mock.method(globalThis, "fetch", async (_url, options) => {
		assert.ok(options.signal instanceof AbortSignal);
		assert.match(options.headers.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
		throw new DOMException("timed out", "TimeoutError");
	});
	t.mock.method(console, "error", () => {});
	const msg = message();
	await relay.email(msg, env);
	assert.deepEqual(msg.rejections, ["Kite is temporarily unavailable, please retry"]);
});

function metrics() {
	const points = [];
	return { points, writeDataPoint: (point) => points.push(point) };
}

async function relayOutcome(t, { rawSize, fetchResult, forward }) {
	const dataset = metrics();
	const msg = message(rawSize ? { rawSize } : {});
	if (forward) msg.forward = forward;
	t.mock.method(console, "error", () => {});
	t.mock.method(globalThis, "fetch", async () => {
		if (fetchResult instanceof Error) throw fetchResult;
		return fetchResult;
	});
	await relay.email(msg, { ...env, METRICS: dataset });
	return dataset.points;
}

test("each relay outcome records exactly one metric without personal data", async (t) => {
	const cases = {
		too_large: { rawSize: 25 * 1024 * 1024 + 1 },
		upstream_too_large: { fetchResult: new Response("", { status: 413 }) },
		upstream_error: { fetchResult: new Error("down for alice@example.com") },
		reject: { fetchResult: Response.json({ action: "reject", reason: "no" }) },
		store: { fetchResult: Response.json({ action: "store", forwardTo: null }) },
		forward: { fetchResult: Response.json({ action: "forward", forwardTo: "x@example.com" }) },
		forward_failed: {
			fetchResult: Response.json({ action: "forward", forwardTo: "x@example.com" }),
			forward: async () => {
				throw new Error("nope");
			},
		},
	};
	for (const [outcome, options] of Object.entries(cases)) {
		const points = await relayOutcome(t, options);
		assert.equal(points.length, 1, outcome);
		assert.deepEqual(points[0].indexes, ["relay"]);
		assert.equal(points[0].blobs[1], "kite-email-relay");
		assert.equal(points[0].blobs[3], outcome);
		assert.ok(points[0].blobs.every((blob) => !blob.includes("@")));
		t.mock.restoreAll();
	}
});

test("relay works without a METRICS binding", async (t) => {
	t.mock.method(globalThis, "fetch", async () => Response.json({ action: "store", forwardTo: null }));
	await relay.email(message(), env);
});
