import assert from "node:assert/strict";
import test from "node:test";
import { buildSummary, classificationProblems, parseLcov } from "../scripts/quality/coverage-utils.mjs";

const root = "/repo";
const exists = (file) => !file.includes("missing") && !file.startsWith("/private/");
const realpath = (file) => file;

const config = {
	gated: ["src/lib/a-utils.ts", "src/lib/b-utils.ts"],
	thresholds: { aggregate: { lines: 80, branches: 90, functions: 95 }, perFile: { branches: 70, functions: 80 } },
	overrides: {},
};

test("parseLcov maps temp-relative and /private paths onto repo files and drops non-source records", () => {
	const lcov = [
		"SF:src/lib/a-utils.ts",
		"LH:8",
		"LF:10",
		"BRH:1",
		"BRF:2",
		"FNH:1",
		"FNF:1",
		"end_of_record",
		"SF:../../private/repo/src/lib/a-utils.ts",
		"LH:9",
		"LF:10",
		"BRH:2",
		"BRF:2",
		"FNH:0",
		"FNF:1",
		"end_of_record",
		"SF:tests/a.test.mjs",
		"LH:1",
		"LF:1",
		"end_of_record",
		"SF:/repo/node_modules/x/index.js",
		"LH:1",
		"LF:1",
		"end_of_record",
	].join("\n");
	const files = parseLcov(lcov, { root, base: "/repo", exists, realpath });
	assert.deepEqual([...files.keys()], ["src/lib/a-utils.ts"]);
	assert.deepEqual(files.get("src/lib/a-utils.ts"), { lines: [9, 10], branches: [2, 2], functions: [1, 1] });
});

test("classificationProblems names unclassified, duplicated, reasonless and stale entries", () => {
	const problems = classificationProblems(
		{
			gated: ["src/lib/a-utils.ts", "src/lib/a-utils.ts"],
			ungated: { "src/lib/c-utils.ts": " ", "src/lib/missing-utils.ts": "why" },
		},
		["src/lib/a-utils.ts", "src/lib/zz/probe-utils.ts", "src/lib/c-utils.ts"],
		exists,
	);
	assert.ok(problems.some((problem) => problem.includes("src/lib/zz/probe-utils.ts is not classified")));
	assert.ok(problems.some((problem) => problem.includes("src/lib/a-utils.ts is listed more than once")));
	assert.ok(problems.some((problem) => problem.includes("src/lib/c-utils.ts is ungated without a reason")));
	assert.ok(problems.some((problem) => problem.includes("src/lib/missing-utils.ts is listed")));
	assert.deepEqual(
		classificationProblems({ gated: ["src/lib/a-utils.ts"], ungated: {} }, ["src/lib/a-utils.ts"], exists),
		[],
	);
});

test("buildSummary passes when per-file and aggregate thresholds hold", () => {
	const measured = new Map([
		["src/lib/a-utils.ts", { lines: [9, 10], branches: [9, 10], functions: [5, 5] }],
		["src/lib/b-utils.ts", { lines: [9, 10], branches: [10, 10], functions: [0, 0] }],
	]);
	const summary = buildSummary(config, measured);
	assert.equal(summary.passed, true);
	assert.deepEqual(Object.keys(summary.aggregate).sort(), [
		"branches",
		"failures",
		"functions",
		"lines",
		"passed",
		"thresholds",
	]);
	assert.equal(summary.files.length, 2);
	assert.equal(summary.files[1].functions, 100);
});

test("buildSummary fails per file, in aggregate and for files without coverage", () => {
	const measured = new Map([["src/lib/a-utils.ts", { lines: [5, 10], branches: [6, 10], functions: [5, 5] }]]);
	const summary = buildSummary(config, measured);
	assert.equal(summary.passed, false);
	assert.match(summary.files[0].failures.join(";"), /branches 60% < 70%/);
	assert.match(summary.files[1].failures.join(";"), /no coverage recorded/);
	assert.match(summary.aggregate.failures.join(";"), /aggregate lines 50% < 80%/);
});

test("overrides replace the per-file thresholds", () => {
	const measured = new Map([
		["src/lib/a-utils.ts", { lines: [8, 10], branches: [9, 10], functions: [5, 5] }],
		["src/lib/b-utils.ts", { lines: [10, 10], branches: [10, 10], functions: [1, 1] }],
	]);
	const strict = { ...config, overrides: { "src/lib/a-utils.ts": { lines: 90 } } };
	const summary = buildSummary(strict, measured);
	assert.match(summary.files[0].failures.join(";"), /lines 80% < 90%/);
});

function duplicateRecords(...records) {
	return records
		.map(([lh, lf, brh, brf, fnh, fnf]) =>
			[
				"SF:src/lib/a-utils.ts",
				`LH:${lh}`,
				`LF:${lf}`,
				`BRH:${brh}`,
				`BRF:${brf}`,
				`FNH:${fnh}`,
				`FNF:${fnf}`,
				"end_of_record",
			].join("\n"),
		)
		.join("\n");
}

test("an empty duplicate record cannot mask a below-threshold complete record", () => {
	const lcov = duplicateRecords([2, 10, 1, 10, 1, 10], [0, 0, 0, 0, 0, 0]);
	const files = parseLcov(lcov, { root, base: "/repo", exists, realpath });
	assert.deepEqual(files.get("src/lib/a-utils.ts"), { lines: [2, 10], branches: [1, 10], functions: [1, 10] });
	const summary = buildSummary(config, new Map([["src/lib/a-utils.ts", files.get("src/lib/a-utils.ts")]]));
	assert.equal(summary.files.find((entry) => entry.file === "src/lib/a-utils.ts").passed, false);
});

test("a smaller tree-shaken duplicate cannot mask a larger record's lower coverage", () => {
	const lcov = duplicateRecords([4, 4, 2, 2, 1, 1], [5, 10, 1, 10, 1, 10]);
	const files = parseLcov(lcov, { root, base: "/repo", exists, realpath });
	assert.deepEqual(files.get("src/lib/a-utils.ts"), { lines: [5, 10], branches: [1, 10], functions: [1, 10] });
});

const sourceMapSplit = (...parts) =>
	parts
		.map((fns) =>
			[
				"SF:src/lib/a-utils.ts",
				...fns.map(([line, name]) => `FN:${line},${name}`),
				...fns.map(([, name, hits]) => `FNDA:${hits},${name}`),
				`FNF:${fns.length}`,
				`FNH:${fns.filter(([, , hits]) => hits > 0).length}`,
				"LH:5",
				"LF:5",
				"end_of_record",
			].join("\n"),
		)
		.join("\n");

test("a function listed twice by source-map line counts once with its highest hits, in either order", () => {
	const covered = [
		[6, "isOk", 3],
		[14, "run", 4],
	];
	const shifted = [[2, "isOk", 0]];
	for (const parts of [[[...covered, ...shifted]], [[...shifted, ...covered]]]) {
		const files = parseLcov(sourceMapSplit(...parts), { root, base: "/repo", exists, realpath });
		assert.deepEqual(files.get("src/lib/a-utils.ts").functions, [2, 2]);
	}
});

test("a function that no record ever hit stays uncovered", () => {
	const files = parseLcov(
		sourceMapSplit([
			[2, "isOk", 0],
			[8, "run", 1],
		]),
		{ root, base: "/repo", exists, realpath },
	);
	assert.deepEqual(files.get("src/lib/a-utils.ts").functions, [1, 2]);
});
