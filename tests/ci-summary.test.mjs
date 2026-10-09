import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { renderSummary } from "../scripts/quality/ci-summary-utils.mjs";

const timings = {
	tasks: [
		{ task: "check", durationMs: 14679, exitCode: 0 },
		{ task: "build:node", skipped: true, reason: "MISSION_SKIP_TASKS" },
		{ task: "test:e2e", durationMs: 1500, exitCode: 1 },
	],
};
const playwright = {
	stats: { expected: 3, unexpected: 0, flaky: 1, skipped: 2 },
	suites: [
		{
			file: "a.spec.ts",
			suites: [{ specs: [{ title: "wobbles", file: "a.spec.ts", tests: [{ status: "flaky" }] }] }],
			specs: [{ title: "steady", file: "a.spec.ts", tests: [{ status: "expected" }] }],
		},
	],
};
const coverage = {
	aggregate: {
		lines: 87,
		branches: 94.1,
		functions: 99.1,
		thresholds: { lines: 80, branches: 90, functions: 95 },
		passed: true,
	},
};

test("renders timings with skipped tasks, flaky tests and coverage", () => {
	const text = renderSummary({ timings, playwright, coverage });
	assert.match(text, /\| check \| 14\.7s \| 0 \|/);
	assert.match(text, /\| build:node \| skipped \| MISSION_SKIP_TASKS \|/);
	assert.match(text, /\*\*1\*\*/);
	assert.match(text, /Passed 3, failed 0, flaky 1, skipped 2/);
	assert.match(text, /- `a\.spec\.ts`: wobbles/);
	assert.doesNotMatch(text, /steady/);
	assert.match(text, /\| lines \| 87% \| 80% \|/);
	assert.match(text, /Gate passed/);
});

test("missing inputs render not-run notes and the CLI exits 0", () => {
	const text = renderSummary({});
	assert.match(text, /Task timings: not run/);
	assert.match(text, /Playwright: not run/);
	assert.match(text, /Coverage: not run/);
	const empty = mkdtempSync(path.join(tmpdir(), "ci-summary-"));
	const out = execFileSync("node", ["scripts/quality/ci-summary.mjs", "--dir", empty], { encoding: "utf8" });
	assert.match(out, /Coverage: not run/);
});

test("the CLI reads the files under the given directory", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "ci-summary-"));
	mkdirSync(path.join(dir, "quality"));
	writeFileSync(path.join(dir, "quality/timings.json"), JSON.stringify(timings));
	const out = execFileSync("node", ["scripts/quality/ci-summary.mjs", "--dir", dir], { encoding: "utf8" });
	assert.match(out, /build:node \| skipped/);
});
