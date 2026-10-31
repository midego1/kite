import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-loading-recovery-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/components/loading-recovery-utils.ts")],
	outfile: join(bundleDirectory, "recovery.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	absWorkingDir: root,
	logLevel: "silent",
});
const { loadingRecoveryDelay, startVisibleClock, tickVisibleClock } = await import(
	pathToFileURL(join(bundleDirectory, "recovery.mjs")).href
);

test("Reload Kite is offered after 15 visible seconds, however often the startup screen remounts", () => {
	assert.equal(loadingRecoveryDelay(0), 15_000);
	assert.equal(loadingRecoveryDelay(4_000), 11_000);
	// A screen mounted again late in a stalled start does not wait another 15 seconds.
	assert.equal(loadingRecoveryDelay(14_900), 100);
	assert.equal(loadingRecoveryDelay(40_000), 0);
	assert.equal(loadingRecoveryDelay(Number.NaN), 15_000);
});

test("the visible clock counts only the time the page was shown", () => {
	// A tab opened in the background: 20 hidden seconds count for nothing.
	let clock = startVisibleClock(1_000, false);
	clock = tickVisibleClock(clock, 21_000, true);
	assert.deepEqual(clock, { visibleMs: 0, visibleSince: 21_000 });
	assert.equal(loadingRecoveryDelay(clock.visibleMs), 15_000);
	// Shown for 6 seconds, hidden for a minute, shown again.
	clock = tickVisibleClock(clock, 27_000, false);
	clock = tickVisibleClock(clock, 87_000, true);
	assert.deepEqual(clock, { visibleMs: 6_000, visibleSince: 87_000 });
	clock = tickVisibleClock(clock, 90_000, true);
	assert.equal(loadingRecoveryDelay(clock.visibleMs), 6_000);
	// A clock that jumps back adds nothing; one that is not a number keeps what was counted.
	assert.equal(tickVisibleClock(clock, 80_000, true).visibleMs, 9_000);
	assert.deepEqual(tickVisibleClock(clock, Number.NaN, true), { visibleMs: 9_000, visibleSince: null });
});
