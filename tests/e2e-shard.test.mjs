import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	assignShards,
	buildGroups,
	collectTests,
	formatTestList,
	isParallelFile,
	parseShard,
	timingsFromReports,
} from "../scripts/quality/e2e-shard-utils.mjs";

const spec = (title, duration) => ({
	title,
	tests: [{ projectName: "chromium", results: duration === undefined ? [] : [{ duration }] }],
});

const report = {
	suites: [
		{
			title: "01-a.spec.ts",
			file: "01-a.spec.ts",
			specs: [spec("first", 1000), spec("second", 3000)],
			suites: [],
		},
		{
			title: "23-p.spec.ts",
			file: "23-p.spec.ts",
			specs: [spec("top", 9000)],
			suites: [{ title: "group", specs: [spec("slow", 20_000), spec("quick", 400)], suites: [] }],
		},
	],
};

test("E2E_SHARD is parsed and refused when malformed", () => {
	assert.deepEqual(parseShard("2/8"), { current: 2, total: 8 });
	for (const value of [undefined, "", "8", "0/4", "5/4", "a/b"]) assert.throws(() => parseShard(value));
});

test("only a top-level parallel configure splits a file per test", () => {
	assert.equal(isParallelFile('import x;\ntest.describe.configure({ mode: "parallel" });\n'), true);
	assert.equal(isParallelFile('test.describe("x", () => {\n\ttest.describe.configure({ mode: "parallel" });\n'), false);
	assert.equal(isParallelFile('test.describe.configure({ mode: "serial" });'), false);
	assert.equal(isParallelFile(readFileSync("e2e/23-auto-agent.spec.ts", "utf8")), true);
});

test("tests are flattened with their describe path and last recorded duration", () => {
	const tests = collectTests(report);
	assert.deepEqual(
		tests.map((t) => [t.key, t.durationMs]),
		[
			["01-a.spec.ts › first", 1000],
			["01-a.spec.ts › second", 3000],
			["23-p.spec.ts › top", 9000],
			["23-p.spec.ts › group › slow", 20_000],
			["23-p.spec.ts › group › quick", 400],
		],
	);
	assert.deepEqual(timingsFromReports([report])["23-p.spec.ts › group › quick"], 400);
});

test("a title the test list cannot select is refused instead of silently dropped", () => {
	const bad = { suites: [{ file: "x.spec.ts", specs: [spec("a › b", 1)], suites: [] }] };
	assert.throws(() => collectTests(bad), /cannot be sharded/);
	const padded = { suites: [{ file: "x.spec.ts", specs: [spec("trailing ", 1)], suites: [] }] };
	assert.throws(() => collectTests(padded), /cannot be sharded/);
});

test("a normal file is one group, a parallel file one group per test, unknown tests count as the median", () => {
	const tests = collectTests(report);
	const timings = { "01-a.spec.ts › first": 1000, "23-p.spec.ts › top": 9000, "23-p.spec.ts › group › slow": 20_000 };
	const groups = buildGroups(tests, new Set(["23-p.spec.ts"]), timings);
	assert.deepEqual(
		groups.map((g) => [g.file, g.titlePath, g.tests, g.durationMs]),
		[
			["01-a.spec.ts", [], 2, 1000 + 9000],
			["23-p.spec.ts", ["top"], 1, 9000],
			["23-p.spec.ts", ["group", "slow"], 1, 20_000],
			["23-p.spec.ts", ["group", "quick"], 1, 9000],
		],
	);
});

test("every group lands in exactly one shard, the load is balanced and the plan ignores input order", () => {
	const groups = Array.from({ length: 40 }, (_, i) => ({
		id: `g${String(i).padStart(2, "0")}`,
		project: "chromium",
		file: `f${i}.spec.ts`,
		titlePath: [],
		tests: 1,
		durationMs: ((i * 7919) % 97) * 100 + 100,
	}));
	const shards = assignShards(groups, 6);
	const placed = shards.flatMap((s) => s.groups.map((g) => g.id)).sort();
	assert.deepEqual(placed, groups.map((g) => g.id).sort());
	const loads = shards.map((s) => s.durationMs);
	assert.ok(Math.max(...loads) - Math.min(...loads) <= Math.max(...groups.map((g) => g.durationMs)));
	const reversed = assignShards([...groups].reverse(), 6);
	assert.deepEqual(
		reversed.map((s) => s.groups.map((g) => g.id)),
		shards.map((s) => s.groups.map((g) => g.id)),
	);
});

test("more shards than groups leaves the extra shards empty", () => {
	const shards = assignShards([{ id: "a", durationMs: 5, tests: 1 }], 3);
	assert.deepEqual(
		shards.map((s) => s.tests),
		[1, 0, 0],
	);
});

test("the test list selects whole files or single tests by title path", () => {
	const lines = formatTestList([
		{ project: "chromium", file: "23-p.spec.ts", titlePath: ["group", "slow"] },
		{ project: "chromium", file: "01-a.spec.ts", titlePath: [] },
	]);
	assert.equal(lines, "[chromium] › 01-a.spec.ts\n[chromium] › 23-p.spec.ts › group › slow\n");
});

test("e2e/timings.json is sorted and holds whole-millisecond durations", () => {
	const timings = JSON.parse(readFileSync("e2e/timings.json", "utf8"));
	const keys = Object.keys(timings);
	assert.ok(keys.length > 100);
	assert.deepEqual(
		keys,
		[...keys].sort((a, b) => a.localeCompare(b)),
	);
	for (const value of Object.values(timings)) assert.ok(Number.isInteger(value) && value >= 0);
});
