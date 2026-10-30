import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-migration-poll-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/components/migration-poll-utils.ts")],
	outfile: join(bundleDirectory, "poll.mjs"),
	bundle: true,
	format: "esm",
	platform: "node",
	logLevel: "silent",
});
const { createStallTracker, isRunFlagActive, isTransientStatus, mergeRemaining, shouldAbortPost, startStatusPolling } =
	await import(pathToFileURL(join(bundleDirectory, "poll.mjs")).href);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("gateway timeouts count as a dropped connection, real failures do not", () => {
	for (const status of [502, 503, 504, 520, 521, 522, 523, 524])
		assert.equal(isTransientStatus(status), true, String(status));
	for (const status of [200, 400, 401, 403, 409, 500, 501, 505, 519, 525]) {
		assert.equal(isTransientStatus(status), false, String(status));
	}
});

test("the pending list never grows back, so an out-of-order answer cannot lower the done count", () => {
	assert.deepEqual(mergeRemaining(null, ["a", "b"]), ["a", "b"]);
	assert.deepEqual(mergeRemaining(["a", "b"], ["b"]), ["b"]);
	assert.deepEqual(mergeRemaining(["b"], ["a", "b"]), ["b"], "an older, longer answer is ignored");
	assert.deepEqual(mergeRemaining(["b"], []), []);
});

test("a slow read is never overlapped by the next one", async () => {
	let running = 0;
	let peak = 0;
	let reads = 0;
	const results = [];
	const stop = startStatusPolling({
		delayMs: 5,
		read: async () => {
			running += 1;
			peak = Math.max(peak, running);
			reads += 1;
			await wait(40);
			running -= 1;
			return reads;
		},
		onResult: (value) => results.push(value),
	});
	await wait(220);
	stop();
	await wait(60);
	assert.equal(peak, 1);
	assert.ok(reads >= 3, `polled ${reads} times`);
	assert.deepEqual(
		results,
		[...results].sort((a, b) => a - b),
	);
	const after = results.length;
	await wait(60);
	assert.equal(results.length, after, "stopped for good");
});

test("a failed read is reported as null and polling goes on", async () => {
	const results = [];
	let calls = 0;
	const stop = startStatusPolling({
		delayMs: 5,
		read: async () => {
			calls += 1;
			if (calls === 1) throw new Error("offline");
			return calls;
		},
		onResult: (value) => results.push(value),
	});
	await wait(80);
	stop();
	assert.equal(results[0], null);
	assert.ok(results.length >= 2 && results[1] === 2);
});

const MINUTE = 60_000;
const tracker = (startCount = 4) =>
	createStallTracker({ stallMs: 3 * MINUTE, capMs: 20 * MINUTE, startedAt: 0, startCount });

test("stall time counts only between polls that answered with an unchanged list", () => {
	const stall = tracker();
	// First answer starts the clock; nothing is stalled yet.
	assert.equal(stall.observe(4, 10_000), false);
	assert.equal(stall.observe(4, 100_000), false);
	assert.equal(stall.observe(4, 190_000), true, "180 s of answered, unchanged polls");
});

test("polls that time out add no stall time, and break the run of answered polls", () => {
	const stall = tracker();
	assert.equal(stall.observe(4, 10_000), false);
	for (let at = 40_000; at <= 600_000; at += 30_000) assert.equal(stall.observe(null, at), false, `timeout at ${at}`);
	// The long gap is unknown, not stalled: the first answer afterwards only restarts the count.
	assert.equal(stall.observe(4, 630_000), false);
	assert.equal(stall.observe(4, 700_000), false);
	assert.equal(stall.observe(4, 800_000), false);
	assert.equal(stall.observe(4, 830_000), true, "200 s answered since 630 s");
});

test("a drop restarts the stall time and the cap", () => {
	const stall = tracker();
	stall.observe(4, 10_000);
	stall.observe(4, 150_000);
	assert.equal(stall.observe(3, 160_000), false);
	assert.equal(stall.observe(3, 300_000), false);
	assert.equal(stall.observe(3, 345_000), true);
});

test("with every poll timing out the run is followed until the cap, then called unknown", () => {
	const stall = tracker();
	assert.equal(stall.observe(null, 19 * MINUTE), false);
	assert.equal(stall.observe(null, 20 * MINUTE), true);
});

test("the POST is cut off once the list has been empty a while with it still open, or after the cap", () => {
	const base = { startedAt: 0 };
	assert.equal(shouldAbortPost({ ...base, emptySince: null, now: 5 * MINUTE }), false);
	assert.equal(shouldAbortPost({ ...base, emptySince: 100_000, now: 110_000 }), false, "a normal answer is on its way");
	assert.equal(shouldAbortPost({ ...base, emptySince: 100_000, now: 115_000 }), true);
	assert.equal(shouldAbortPost({ ...base, emptySince: null, now: 14 * MINUTE }), false);
	assert.equal(shouldAbortPost({ ...base, emptySince: null, now: 15 * MINUTE }), true);
});

test("another tab's run flag counts only while it is fresh, and not when it is from the future", () => {
	assert.equal(isRunFlagActive(null, 100_000), false);
	assert.equal(isRunFlagActive("garbage", 100_000), false);
	assert.equal(isRunFlagActive("95000", 100_000), true);
	assert.equal(isRunFlagActive("30000", 100_000), true, "a hidden tab's heartbeat can be a minute apart");
	assert.equal(isRunFlagActive("20000", 100_000), false);
	assert.equal(isRunFlagActive("103000", 100_000), true, "a small clock difference between tabs");
	assert.equal(isRunFlagActive(String(100_000 + 3_600_000), 100_000), false, "an hour ahead is not a heartbeat");
});
