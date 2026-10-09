import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { summarizeZap } from "../scripts/ci/zap-summary.mjs";

test("release.yml checks that an existing release is a draft before editing it", () => {
	const yaml = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
	const edit = yaml.indexOf("gh release edit");
	const draftCheck = yaml.indexOf("isDraft");
	assert.ok(draftCheck !== -1 && draftCheck < edit, "isDraft must be read before gh release edit");
	assert.doesNotMatch(yaml, /gh release edit[^\n]*--draft=false/);
});

test("summarizeZap reports WARN, FAIL, IGNORE and PASS dispositions from the baseline log", () => {
	const log = "FAIL-NEW: 1\tFAIL-INPROG: 0\tWARN-NEW: 3\tWARN-INPROG: 2\tINFO: 0\tIGNORE: 4\tPASS: 55\n";
	const out = summarizeZap({ log, report: null });
	assert.match(out, /\| FAIL \| 1 \|/);
	assert.match(out, /\| WARN \| 5 \|/);
	assert.match(out, /\| IGNORE \| 4 \|/);
	assert.match(out, /\| PASS \| 55 \|/);
	assert.doesNotMatch(out, /High \(FAIL\)/);
});

test("summarizeZap lists WARN rules from the JSON report and handles a missing log", () => {
	const report = {
		site: [{ alerts: [{ pluginid: "10038", alert: "CSP Header Not Set", riskdesc: "Medium (High)" }] }],
	};
	const out = summarizeZap({ log: "", report });
	assert.match(out, /10038/);
	assert.match(out, /Medium/);
	assert.match(out, /no disposition totals/i);
});
