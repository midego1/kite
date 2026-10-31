import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-applied-notice-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/components/applied-notice-utils.ts")],
	outfile: join(bundleDirectory, "notice.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	absWorkingDir: root,
	logLevel: "silent",
});
const { APPLIED_NOTICE_STAY_MS, createDismissTimer, isAppliedNoticeExitEnd, planAppliedNoticeExit } = await import(
	pathToFileURL(join(bundleDirectory, "notice.mjs")).href
);

/** A clock whose timers fire only when the test advances it. */
function fakeClock() {
	let now = 1_000;
	let nextHandle = 1;
	const timers = new Map();
	return {
		now: () => now,
		setTimeout(callback, ms) {
			const handle = nextHandle++;
			timers.set(handle, { at: now + ms, callback });
			return handle;
		},
		clearTimeout(handle) {
			timers.delete(handle);
		},
		advance(ms) {
			const until = now + ms;
			for (const [handle, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
				if (timer.at > until) continue;
				now = timer.at;
				timers.delete(handle);
				timer.callback();
			}
			now = until;
		},
		pending: () => timers.size,
	};
}

function start(clock, options = {}) {
	const elapsed = [];
	const timer = createDismissTimer(
		{ stayMs: APPLIED_NOTICE_STAY_MS, onElapsed: () => elapsed.push(clock.now()), ...options },
		clock,
	);
	return { timer, elapsed };
}

test("the notice stays for eight seconds, then leaves once", () => {
	const clock = fakeClock();
	const { timer, elapsed } = start(clock);
	clock.advance(APPLIED_NOTICE_STAY_MS - 1);
	assert.deepEqual(elapsed, []);
	assert.equal(timer.remainingMs(), 1);
	clock.advance(1);
	assert.deepEqual(elapsed, [1_000 + APPLIED_NOTICE_STAY_MS]);
	clock.advance(60_000);
	assert.equal(elapsed.length, 1);
	assert.equal(clock.pending(), 0);
});

test("a hold pauses the countdown and it resumes with the time that was left", () => {
	const clock = fakeClock();
	const { timer, elapsed } = start(clock);
	clock.advance(3_000);
	timer.hold("hover");
	assert.equal(timer.holding(), true);
	clock.advance(60_000);
	assert.deepEqual(elapsed, [], "nothing happens while the pointer is on the notice");
	assert.equal(timer.remainingMs(), 5_000);
	timer.release("hover");
	assert.equal(timer.holding(), false);
	clock.advance(4_999);
	assert.deepEqual(elapsed, []);
	clock.advance(1);
	assert.equal(elapsed.length, 1);
});

test("several reasons hold at once and the countdown resumes only when the last one is gone", () => {
	const clock = fakeClock();
	const { timer, elapsed } = start(clock);
	timer.hold("hover");
	timer.hold("focus");
	timer.hold("hidden");
	timer.hold("hover");
	timer.release("hover");
	timer.release("hidden");
	clock.advance(60_000);
	assert.deepEqual(elapsed, [], "the focus still holds it");
	timer.release("focus");
	// Releasing an unknown or already released reason changes nothing.
	timer.release("hover");
	timer.release("nothing");
	clock.advance(APPLIED_NOTICE_STAY_MS);
	assert.equal(elapsed.length, 1);
});

test("after a hold ends the notice stays at least two more seconds", () => {
	const clock = fakeClock();
	const { timer, elapsed } = start(clock);
	clock.advance(APPLIED_NOTICE_STAY_MS - 100);
	timer.hold("hover");
	clock.advance(10_000);
	timer.release("hover");
	assert.equal(timer.remainingMs(), 2_000);
	clock.advance(1_999);
	assert.deepEqual(elapsed, []);
	clock.advance(1);
	assert.equal(elapsed.length, 1);
});

test("a hold that starts with the tab hidden keeps the countdown from starting at all", () => {
	const clock = fakeClock();
	const { timer, elapsed } = start(clock);
	timer.hold("hidden");
	clock.advance(600_000);
	assert.deepEqual(elapsed, []);
	assert.equal(timer.remainingMs(), APPLIED_NOTICE_STAY_MS);
	timer.release("hidden");
	clock.advance(APPLIED_NOTICE_STAY_MS);
	assert.equal(elapsed.length, 1);
});

test("cancel stops the countdown for good; holds and releases after it do nothing", () => {
	const clock = fakeClock();
	const { timer, elapsed } = start(clock);
	clock.advance(1_000);
	timer.cancel();
	timer.hold("hover");
	timer.release("hover");
	clock.advance(60_000);
	assert.deepEqual(elapsed, []);
	assert.equal(clock.pending(), 0);
});

test("the exit is a flight with the kite, or a short fade under reduced motion", () => {
	const flight = planAppliedNoticeExit(false);
	assert.equal(flight.kite, true);
	// The flight's length is the one in globals.css (`applied-notice-kite`), about 1.2 s.
	assert.equal(flight.durationMs, 1_200);
	assert.ok(flight.fallbackMs > flight.durationMs, "the fallback waits for the flight");
	const fade = planAppliedNoticeExit(true);
	assert.equal(fade.kite, false);
	assert.equal(fade.durationMs, 250);
	assert.ok(fade.fallbackMs > fade.durationMs);
	assert.ok(fade.fallbackMs < flight.durationMs, "reduced motion is over before the flight would be");
});

test("only the kite's animation (or the fade without it) ends the exit", () => {
	const flight = planAppliedNoticeExit(false);
	assert.equal(isAppliedNoticeExitEnd("applied-notice-kite", flight), true);
	assert.equal(isAppliedNoticeExitEnd("applied-notice-leave", flight), false, "the box's fold ends first");
	assert.equal(isAppliedNoticeExitEnd("reload-flight-tail", flight), false, "the tail ripples until the end");
	assert.equal(isAppliedNoticeExitEnd("applied-notice-fade", flight), false);
	const fade = planAppliedNoticeExit(true);
	assert.equal(isAppliedNoticeExitEnd("applied-notice-fade", fade), true);
	assert.equal(isAppliedNoticeExitEnd("applied-notice-kite", fade), false);
});
