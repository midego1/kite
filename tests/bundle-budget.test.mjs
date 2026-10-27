import assert from "node:assert/strict";
import test from "node:test";
import {
	addedAllowanceFiles,
	checkBundles,
	effectiveBudgets,
	describeBundles,
	growthLimits,
	isAllowanceFile,
	parseAllowance,
	resolveBundleBase,
} from "../scripts/quality/bundle-budget-utils.mjs";

const budgets = {
	client: { bytes: 1000, gzipBytes: 400 },
	worker: { bytes: 5000, gzipBytes: 2000 },
	growth: { client: { bytes: 60, gzipBytes: 20 }, worker: { bytes: 160, gzipBytes: 40 } },
};
const total = (client, worker) => ({
	client: { files: 3, bytes: client[0], gzipBytes: client[1] },
	worker: { files: 9, bytes: worker[0], gzipBytes: worker[1] },
});
const base = total([800, 300], [4000, 1500]);
const allowance = (value) => parseAllowance(JSON.stringify({ reason: "A new editor ships its own parser.", ...value }));

test("a build inside the ceiling and the growth limits passes, a smaller one too", () => {
	assert.deepEqual(checkBundles({ results: total([850, 315], [4100, 1520]), budgets, base }).problems, []);
	assert.deepEqual(checkBundles({ results: total([700, 250], [3000, 1000]), budgets, base }).problems, []);
});

test("growth exactly at the limit passes and one byte over fails, per kind and metric", () => {
	assert.deepEqual(checkBundles({ results: total([860, 320], [4160, 1540]), budgets, base }).problems, []);
	const over = checkBundles({ results: total([861, 320], [4160, 1541]), budgets, base }).problems;
	assert.equal(over.length, 2);
	assert.match(over[0], /^client bytes grew by 61 against the base, above this pull request's limit of 60/);
	assert.match(over[1], /^worker gzipBytes grew by 41 .* limit of 40/);
});

test("the absolute ceiling applies with or without a base", () => {
	const results = total([1001, 400], [5000, 2001]);
	for (const given of [base, null]) {
		const { problems } = checkBundles({ results, budgets, base: given });
		assert.ok(problems.some((problem) => /^client bytes is 1,001, above the 1,000 ceiling/.test(problem)));
		assert.ok(problem(problems, "worker gzipBytes is 2,001"));
	}
	const none = checkBundles({ results: total([900, 300], [4000, 1500]), budgets });
	assert.deepEqual(none.problems, []);
	assert.equal(none.growth, null);
	assert.equal(none.limits, null);
});
function problem(problems, start) {
	return problems.some((entry) => entry.startsWith(start));
}

test("an allowance raises only this pull request's limits, added together, never the ceiling", () => {
	const first = allowance({ client: { gzipBytes: 30 } }).allowance;
	const second = allowance({ client: { gzipBytes: 5, bytes: 100 }, worker: { bytes: 1 } }).allowance;
	assert.deepEqual(growthLimits(budgets.growth, [first, second]), {
		client: { bytes: 160, gzipBytes: 55 },
		worker: { bytes: 161, gzipBytes: 40 },
	});
	const results = total([960, 350], [4100, 1500]);
	assert.equal(checkBundles({ results, budgets, base }).problems.length, 2);
	assert.deepEqual(checkBundles({ results, budgets, base, allowances: [first, second] }).problems, []);
	const huge = allowance({ client: { bytes: 1000, gzipBytes: 100 } }).allowance;
	const ceiling = checkBundles({ results: total([1100, 350], [4100, 1500]), budgets, base, allowances: [huge] });
	assert.equal(ceiling.problems.length, 1);
	assert.match(ceiling.problems[0], /^client bytes is 1,100, above the 1,000 ceiling/);
});

test("the reported growth is the signed difference from the base", () => {
	const { growth, limits } = checkBundles({ results: total([790, 310], [4100, 1500]), budgets, base });
	assert.deepEqual(growth.client, { bytes: -10, gzipBytes: 10 });
	assert.deepEqual(growth.worker, { bytes: 100, gzipBytes: 0 });
	assert.equal(limits.worker.bytes, 160);
});

test("allowance files must be valid, say why, and grant something", () => {
	assert.deepEqual(allowance({ worker: { gzipBytes: 9 } }).problems, []);
	const cases = [
		["not json", /not valid JSON/],
		["[]", /must be a JSON object/],
		[JSON.stringify({ client: { gzipBytes: 5 } }), /"reason"/],
		[JSON.stringify({ reason: "short" }), /"reason"/],
		[JSON.stringify({ reason: "A long enough reason." }), /grants nothing/],
		[JSON.stringify({ reason: "A long enough reason.", server: { bytes: 1 } }), /unknown key "server"/],
		[JSON.stringify({ reason: "A long enough reason.", client: { kb: 1 } }), /unknown metric "client.kb"/],
		[JSON.stringify({ reason: "A long enough reason.", client: { bytes: -1 } }), /non-negative integer/],
		[JSON.stringify({ reason: "A long enough reason.", client: { bytes: 1.5 } }), /non-negative integer/],
		[JSON.stringify({ reason: "A long enough reason.", client: 5 }), /"client" must be an object/],
	];
	for (const [text, pattern] of cases) {
		const parsed = parseAllowance(text, "f.json");
		assert.equal(parsed.allowance, null, text);
		assert.match(parsed.problems.join("\n"), pattern, text);
	}
});

test("only json files directly in bundle-growth.d are allowances", () => {
	assert.equal(isAllowanceFile("bundle-growth.d/big-editor.json"), true);
	for (const name of [
		"bundle-growth.d/Big.json",
		"bundle-growth.d/notes.txt",
		"bundle-growth.d/sub/a.json",
		"changelog.d/a.json",
		"bundle-growth.d",
		"../bundle-growth.d/a.json",
	])
		assert.equal(isAllowanceFile(name), false, name);
});

test("the printed lines show totals and, with a base, the change against its limit", () => {
	const results = total([850, 315], [4100, 1520]);
	const plain = describeBundles(results, null, null);
	assert.equal(plain[0], "client: 3 JavaScript files, 850 raw bytes, 315 gzip bytes");
	const { growth, limits } = checkBundles({ results, budgets, base });
	const lines = describeBundles(results, growth, limits);
	assert.match(lines[0], /against the base: raw \+50 \(limit 60\), gzip \+15 \(limit 20\)$/);
	assert.match(lines[1], /raw \+100 \(limit 160\), gzip \+20 \(limit 40\)$/);
});

test("the base is the merge commit's first parent on a pull request, and must exist there", () => {
	const calls = [];
	const git = (...args) => {
		calls.push(args.join(" "));
		if (args[0] === "cat-file" && args[1] === "-p") return "tree t\nparent aaa111\nparent bbb222\nauthor x";
		if (args[0] === "cat-file") return "";
		if (args[0] === "rev-parse") return args[2].replace(/\^\{commit\}$/, "");
		throw new Error(`unexpected ${args.join(" ")}`);
	};
	const env = { GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "main" };
	assert.deepEqual(resolveBundleBase({ env, git }), { sha: "aaa111" });
	const broken = () => {
		throw new Error("no such commit");
	};
	assert.deepEqual(resolveBundleBase({ env, git: broken }), {
		reason: "the base commit is not available (fetch it, or pass --base <ref>)",
		expected: false,
	});
});

test("an explicit base wins, none skips on purpose, and a push or a local run has its own rule", () => {
	const git = (...args) => (args[0] === "merge-base" ? "mmm" : args[2].replace(/\^\{commit\}$/, ""));
	assert.deepEqual(resolveBundleBase({ requested: "HEAD~3", env: { GITHUB_EVENT_NAME: "pull_request" }, git }), {
		sha: "HEAD~3",
	});
	assert.deepEqual(resolveBundleBase({ requested: "none", env: { GITHUB_EVENT_NAME: "pull_request" }, git }), {
		reason: "BUNDLE_BASE=none",
		expected: true,
	});
	assert.deepEqual(resolveBundleBase({ env: { GITHUB_EVENT_NAME: "push" }, git }), {
		reason: "a push has no base",
		expected: true,
	});
	assert.deepEqual(resolveBundleBase({ env: {}, git }), { sha: "mmm" });
});

test("only allowance files the base does not have are this pull request's", () => {
	const inBase = new Set(["bundle-growth.d/old.json"]);
	const { files, problems } = addedAllowanceFiles(["old.json", "new.json", "Bad.json", "notes.txt", "a.json"], inBase);
	assert.deepEqual(files, ["bundle-growth.d/a.json", "bundle-growth.d/new.json"]);
	assert.equal(problems.length, 2);
	assert.match(problems.join("\n"), /bundle-growth\.d\/Bad\.json: use a lowercase file name/);
	assert.deepEqual(addedAllowanceFiles([], new Set()), { files: [], problems: [] });
});

test("the growth limits come from the base's budgets so a pull request cannot raise its own", () => {
	const raised = { ...budgets, growth: { ...budgets.growth, client: { bytes: 9e9, gzipBytes: 9e9 } } };
	assert.equal(effectiveBudgets(raised, budgets).growth, budgets.growth);
	assert.equal(effectiveBudgets(raised, null).growth, raised.growth);
	assert.equal(effectiveBudgets(raised, { client: {}, worker: {} }).growth, raised.growth);
	const ceilings = { ...budgets, client: { bytes: 2000, gzipBytes: 800 } };
	assert.deepEqual(effectiveBudgets(ceilings, budgets).client, { bytes: 2000, gzipBytes: 800 });
});
