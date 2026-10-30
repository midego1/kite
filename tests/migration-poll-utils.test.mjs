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
const { createStallTracker, isRunFlagActive, isTransientStatus, mergeRemaining, startStatusPolling } = await import(
	pathToFileURL(join(bundleDirectory, "poll.mjs")).href
);

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

test("the stall tracker fires after the window without the count dropping, and a drop restarts it", () => {
	const stall = createStallTracker(180_000, 1_000, 4);
	assert.equal(stall.observe(4, 60_000), false);
	assert.equal(stall.observe(3, 170_000), false, "a drop restarts the window");
	assert.equal(stall.observe(3, 340_000), false);
	assert.equal(stall.observe(3, 350_000), true);
	assert.equal(stall.observe(2, 351_000), false);
});

test("another tab's run flag counts only while it is fresh", () => {
	assert.equal(isRunFlagActive(null, 100_000), false);
	assert.equal(isRunFlagActive("garbage", 100_000), false);
	assert.equal(isRunFlagActive("95000", 100_000), true);
	assert.equal(isRunFlagActive("70000", 100_000), false);
});
