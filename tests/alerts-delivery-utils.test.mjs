import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-alerts-delivery-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	entryPoints: {
		delivery: join(root, "src/lib/alerts/delivery-utils.ts"),
		active: join(root, "src/lib/alerts/active-utils.ts"),
	},
	outdir: bundleDirectory,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node24",
	logLevel: "silent",
});
const { decideDeliveryOutcome, runWithRetry, classifyWebhookResponse, classifyDeliveryError } = await import(
	pathToFileURL(join(bundleDirectory, "delivery.mjs")).href
);
const { toActiveAlertView, alertSetSignature } = await import(pathToFileURL(join(bundleDirectory, "active.mjs")).href);

const sent = { channel: "email", outcome: "sent" };
const failed = { channel: "webhook", outcome: "failed", reason: "http_status" };
const skipped = { channel: "webhook", outcome: "skipped", reason: "not_configured" };

test("one sent channel is enough to count as delivered", () => {
	assert.equal(decideDeliveryOutcome([sent]), "delivered");
	assert.equal(decideDeliveryOutcome([failed, sent]), "delivered");
	assert.equal(decideDeliveryOutcome([skipped, sent]), "delivered");
	assert.equal(decideDeliveryOutcome([failed]), "failed");
	assert.equal(decideDeliveryOutcome([skipped, failed]), "failed");
	assert.equal(decideDeliveryOutcome([skipped, { ...skipped, channel: "email" }]), "skipped");
	assert.equal(decideDeliveryOutcome([]), "skipped");
});

const recordingSleep = () => {
	const delays = [];
	return { delays, sleep: async (ms) => void delays.push(ms) };
};

test("a first-try success does not wait or retry", async () => {
	const { delays, sleep } = recordingSleep();
	const calls = [];
	const result = await runWithRetry(
		async (signal, attempt) => {
			calls.push(attempt);
			assert.ok(signal instanceof AbortSignal);
			return "done";
		},
		{ timeoutMs: 1000, delayMs: 1000, sleep },
	);
	assert.deepEqual(result, { ok: true, value: "done", attempts: 1 });
	assert.deepEqual(calls, [1]);
	assert.deepEqual(delays, []);
});

test("a thrown error is retried once after the delay", async () => {
	const { delays, sleep } = recordingSleep();
	const calls = [];
	const result = await runWithRetry(
		(_signal, attempt) => {
			calls.push(attempt);
			if (attempt === 1) throw new Error("boom");
			return Promise.resolve(42);
		},
		{ timeoutMs: 1000, delayMs: 1000, sleep },
	);
	assert.deepEqual(result, { ok: true, value: 42, attempts: 2 });
	assert.deepEqual(calls, [1, 2]);
	assert.deepEqual(delays, [1000]);
});

test("two rejected attempts report the last error", async () => {
	const { delays, sleep } = recordingSleep();
	let calls = 0;
	const result = await runWithRetry(
		async (_signal, attempt) => {
			calls += 1;
			throw new Error(`failure ${attempt}`);
		},
		{ attempts: 2, timeoutMs: 1000, delayMs: 250, sleep },
	);
	assert.equal(result.ok, false);
	assert.equal(result.attempts, 2);
	assert.equal(result.error.message, "failure 2");
	assert.equal(calls, 2);
	assert.deepEqual(delays, [250]);
});

test("each attempt gets its own timeout and a timeout is a failure", async () => {
	const { sleep } = recordingSleep();
	const signals = [];
	const started = Date.now();
	const result = await runWithRetry(
		(signal) => {
			signals.push(signal);
			// Never settles: only the per-attempt timeout ends it.
			return new Promise(() => {});
		},
		{ timeoutMs: 30, delayMs: 0, sleep },
	);
	assert.equal(result.ok, false);
	assert.equal(result.attempts, 2);
	assert.equal(classifyDeliveryError(result.error), "timeout");
	assert.equal(signals.length, 2);
	assert.notEqual(signals[0], signals[1]);
	assert.ok(signals.every((signal) => signal.aborted));
	assert.ok(Date.now() - started >= 55);
});

test("a timed-out first attempt can succeed on the retry", async () => {
	const { delays, sleep } = recordingSleep();
	const result = await runWithRetry(
		(signal, attempt) =>
			attempt === 1
				? new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)))
				: Promise.resolve("second"),
		{ timeoutMs: 20, delayMs: 5, sleep },
	);
	assert.deepEqual(result, { ok: true, value: "second", attempts: 2 });
	assert.deepEqual(delays, [5]);
});

test("the default sleep waits between attempts", async () => {
	const started = Date.now();
	const result = await runWithRetry(
		async (_signal, attempt) => {
			if (attempt === 1) throw new Error("first");
			return "ok";
		},
		{ timeoutMs: 1000, delayMs: 20 },
	);
	assert.equal(result.ok, true);
	assert.ok(Date.now() - started >= 15);
});

test("only 2xx responses count as delivered", () => {
	for (const status of [200, 201, 204, 299])
		assert.deepEqual(classifyWebhookResponse(status), { ok: true }, String(status));
	for (const status of [199, 301, 302, 400, 404, 500, 503]) {
		assert.deepEqual(classifyWebhookResponse(status), { ok: false, reason: "http_status" }, String(status));
	}
});

test("errors are classified as timeout or network", () => {
	assert.equal(classifyDeliveryError(new DOMException("t", "TimeoutError")), "timeout");
	assert.equal(classifyDeliveryError(new DOMException("a", "AbortError")), "timeout");
	assert.equal(classifyDeliveryError(new TypeError("fetch failed")), "network");
	assert.equal(classifyDeliveryError("odd"), "network");
});

test("active alerts map to rule, name, count and href in rule order", () => {
	const view = toActiveAlertView([
		{ rule: "webhook_exhausted", fingerprint: "active", count: 1 },
		{ rule: "outbound_stuck", fingerprint: "active", count: 3 },
		{ rule: "backup_failed", fingerprint: "bak_1", count: 1 },
		{ rule: "outbound_failed", fingerprint: "active", count: 7 },
	]);
	assert.deepEqual(view, [
		{ rule: "backup_failed", name: "Failed backups", count: 1, href: "/backups" },
		{ rule: "outbound_failed", name: "Failed outbound sends in the last hour", count: 7, href: "/admin" },
		{ rule: "outbound_stuck", name: "Outbound messages stuck in the queue", count: 3, href: "/admin" },
		{ rule: "webhook_exhausted", name: "Webhook deliveries that ran out of retries", count: 1, href: "/webhooks" },
	]);
	for (const item of view) assert.deepEqual(Object.keys(item).sort(), ["count", "href", "name", "rule"]);
	assert.deepEqual(toActiveAlertView([]), []);
});

test("the alert set signature ignores order and counts", () => {
	assert.equal(alertSetSignature([]), null);
	const a = [
		{ rule: "outbound_stuck", fingerprint: "active", count: 1 },
		{ rule: "backup_failed", fingerprint: "bak_1,bak_2", count: 2 },
	];
	const b = [
		{ rule: "backup_failed", fingerprint: "bak_1,bak_2", count: 9 },
		{ rule: "outbound_stuck", fingerprint: "active", count: 4 },
	];
	const signature = alertSetSignature(a);
	assert.equal(typeof signature, "string");
	assert.equal(signature, alertSetSignature(b));
	assert.equal(signature, alertSetSignature(a));
	assert.notEqual(signature, alertSetSignature([a[0]]));
	assert.notEqual(signature, alertSetSignature([a[0], { ...a[1], fingerprint: "bak_1,bak_2,bak_3" }]));
	assert.notEqual(
		alertSetSignature([{ rule: "outbound_stuck", fingerprint: "active", count: 1 }]),
		alertSetSignature([{ rule: "outbound_failed", fingerprint: "active", count: 1 }]),
	);
});
