import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-startup-steps-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/components/startup-steps-utils.ts")],
	outfile: join(bundleDirectory, "steps.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	absWorkingDir: root,
	logLevel: "silent",
});
const { currentStartupStep, planStartupSteps, startupStepCounter } = await import(
	pathToFileURL(join(bundleDirectory, "steps.mjs")).href
);

const STARTUP_STEP_COUNT = 5;
const ready = (stats, extra = {}) => planStartupSteps({ ...base, mounted: true, ready: true, stats, ...extra });

const base = {
	mounted: false,
	ready: false,
	complete: false,
	version: "2026.10.31.0",
	commit: "abc1234",
	stats: {},
	elapsedMs: 0,
};

const states = (steps) => steps.map((step) => step.state);

test("the server's screen runs the first line and waits with the rest", () => {
	const steps = planStartupSteps(base);
	assert.equal(steps.length, STARTUP_STEP_COUNT);
	assert.deepEqual(states(steps), ["running", "todo", "todo", "todo", "todo"]);
	assert.equal(steps[0].label, "Loading Kite v2026.10.31.0");
	// The build's commit is static, so even the server's screen names it.
	assert.equal(steps[0].detail, "abc1234");
	assert.equal(startupStepCounter(steps), "STEP 1/5");
	assert.equal(currentStartupStep(steps)?.id, "load");
});

test("once React runs the screen the session line runs, and the database and mail wait for it", () => {
	const steps = planStartupSteps({ ...base, mounted: true });
	assert.deepEqual(states(steps), ["done", "running", "todo", "todo", "todo"]);
	assert.equal(steps[0].detail, "abc1234");
	assert.equal(steps[1].label, "Signing you in…");
	assert.equal(startupStepCounter(steps), "STEP 2/5");
});

test("an unknown commit shows no detail", () => {
	const steps = planStartupSteps({ ...base, mounted: true, commit: "unknown" });
	assert.equal(steps[0].detail, "");
});

test("the session answers: the account is named and the database line runs", () => {
	const steps = planStartupSteps({ ...base, mounted: true, ready: true, stats: { sessionName: "Jamie" } });
	assert.deepEqual(states(steps), ["done", "done", "running", "todo", "todo"]);
	assert.equal(steps[1].label, "Signed in");
	assert.equal(steps[1].detail, "Jamie");
	assert.equal(startupStepCounter(steps), "STEP 3/5");
});

test("facts may arrive out of order: the mail line can be done while the database still runs", () => {
	const steps = planStartupSteps({ ...base, mounted: true, ready: true, stats: { mailboxes: 3, unread: 12 } });
	assert.deepEqual(states(steps), ["done", "done", "running", "done", "todo"]);
	assert.equal(steps[3].detail, "3 mailboxes · 12 unread");
	assert.equal(startupStepCounter(steps), "STEP 3/5");
});

test("the database line says up to date or how many updates wait, and warns about the latter", () => {
	const upToDate = planStartupSteps({ ...base, mounted: true, ready: true, stats: { pendingMigrations: 0 } });
	assert.equal(upToDate[2].state, "done");
	assert.equal(upToDate[2].detail, "Up to date");
	assert.equal(upToDate[2].warn, false);
	const waiting = planStartupSteps({ ...base, mounted: true, ready: true, stats: { pendingMigrations: 2 } });
	assert.equal(waiting[2].detail, "2 updates waiting");
	assert.equal(waiting[2].warn, true);
	assert.equal(
		planStartupSteps({ ...base, mounted: true, ready: true, stats: { pendingMigrations: 1 } })[2].detail,
		"1 update waiting",
	);
	assert.deepEqual(states(waiting), ["done", "done", "done", "running", "todo"]);
	assert.equal(startupStepCounter(waiting), "STEP 4/5");
});

test("the database line is empty until the fact is in", () => {
	assert.equal(ready({})[2].detail, "");
	assert.equal(ready({ pendingMigrations: 3 })[2].detail, "3 updates waiting");
});

test("the mail line names what it knows", () => {
	assert.equal(ready({})[3].detail, "");
	assert.equal(ready({ mailboxes: 1 })[3].detail, "1 mailbox");
	assert.equal(ready({ unread: 0 })[3].detail, "0 unread");
	assert.equal(ready({ mailboxes: 2, unread: 5 })[3].detail, "2 mailboxes · 5 unread");
});

test("completion marks every line done with the elapsed time, also lines whose fact never came", () => {
	const steps = planStartupSteps({
		...base,
		mounted: true,
		ready: true,
		complete: true,
		elapsedMs: 1_432,
		stats: { sessionName: "Jamie", unread: 4 },
	});
	assert.deepEqual(states(steps), ["done", "done", "done", "done", "done"]);
	assert.equal(steps[2].detail, "");
	assert.equal(steps[2].warn, false);
	assert.equal(steps[3].detail, "4 unread");
	assert.equal(steps[4].detail, "1.4 s");
	assert.equal(startupStepCounter(steps), "STEP 5/5");
	assert.equal(currentStartupStep(steps)?.id, "ready");
});

test("elapsed time reads in seconds, then minutes, and never negative", () => {
	const elapsed = (elapsedMs) => ready({}, { complete: true, elapsedMs })[4].detail;
	assert.equal(elapsed(0), "0.0 s");
	assert.equal(elapsed(940), "0.9 s");
	assert.equal(elapsed(59_949), "59.9 s");
	assert.equal(elapsed(65_000), "1 min 05 s");
	assert.equal(elapsed(-20), "0.0 s");
	assert.equal(elapsed(Number.NaN), "0.0 s");
});

test("the counter falls back to the last done line when nothing runs", () => {
	const steps = planStartupSteps({ ...base, mounted: true, ready: false });
	// Session cannot be done without ready, so force a shape with a gap: everything done except a blocked one.
	const odd = steps.map((step, index) => (index < 2 ? { ...step, state: "done" } : { ...step, state: "todo" }));
	assert.equal(startupStepCounter(odd), "STEP 2/5");
	assert.equal(currentStartupStep(odd)?.id, "session");
	assert.equal(startupStepCounter(steps.map((step) => ({ ...step, state: "todo" }))), "STEP 1/5");
	assert.equal(currentStartupStep(steps.map((step) => ({ ...step, state: "todo" }))), undefined);
});
