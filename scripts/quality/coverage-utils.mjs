import fs from "node:fs";
import path from "node:path";

const SOURCE_PATTERN = /^(src\/|server\/|worker-utils\.ts$)/;

/**
 * Parses lcov text into per-file counters. `SF:` paths are relative to the
 * directory the test run started in. Bundles live in the OS temp directory or
 * below the repo, and the real path of a temp directory (macOS `/private/var`)
 * is one level deeper than the path esbuild computed its relative `sources`
 * from, so a resolved path can gain a spurious `/private` prefix; it is
 * stripped when that is the only way the file exists. Paths are then passed
 * through `realpathSync` and made repo-relative. Records outside the
 * application source (stdin entries, node_modules, tests) are dropped.
 *
 * A source file can have several records (one per coverage run that loaded
 * it). Lines are merged by line number (`DA`) and functions by name (`FN` /
 * `FNDA`), keeping the highest hit count, so the result does not depend on
 * record order: a run that bundled a module without calling it cannot hide a
 * run that did. A bundle whose source map places a function on a different
 * line adds a second `FN` entry for it, which is why functions are keyed by
 * name. Branch indices are positional per record and cannot be lined up, so
 * for branches (and for records that only carry `LH`/`LF`/`FNH`/`FNF` totals)
 * the record with the largest denominator represents the file, ties going to
 * the most hits. Choosing by ratio would let an empty or tree-shaken record
 * hide a module that is under-tested.
 */
export function parseLcov(text, { root, base = root, exists = fs.existsSync, realpath = fs.realpathSync } = {}) {
	const realRoot = realpath(root);
	const records = new Map();
	let current = null;
	for (const line of text.split("\n")) {
		if (line.startsWith("SF:")) {
			let absolute = path.resolve(base, line.slice(3));
			if (!exists(absolute) && absolute.startsWith("/private/") && exists(absolute.slice("/private".length))) {
				absolute = absolute.slice("/private".length);
			}
			const resolved = exists(absolute) ? realpath(absolute) : absolute;
			const relative = path.relative(realRoot, resolved).split(path.sep).join("/");
			current = null;
			if (SOURCE_PATTERN.test(relative) && exists(resolved)) {
				current = { lines: [0, 0], branches: [0, 0], functions: [0, 0], named: new Map(), numbered: new Map() };
				if (!records.has(relative)) records.set(relative, []);
				records.get(relative).push(current);
			}
			continue;
		}
		if (!current) continue;
		const colon = line.indexOf(":");
		const key = line.slice(0, colon);
		if (key === "FN" || key === "FNDA") {
			const [first, ...rest] = line.slice(colon + 1).split(",");
			const name = rest.join(",");
			if (key === "FNDA") keepMax(current.named, name, Number(first));
			else keepMax(current.named, name, 0);
			continue;
		}
		if (key === "DA") {
			const [lineNumber, hits] = line.slice(colon + 1).split(",");
			keepMax(current.numbered, lineNumber, Number(hits));
			continue;
		}
		const value = Number(line.slice(colon + 1));
		if (key === "LH") current.lines[0] = value;
		else if (key === "LF") current.lines[1] = value;
		else if (key === "BRH") current.branches[0] = value;
		else if (key === "BRF") current.branches[1] = value;
		else if (key === "FNH") current.functions[0] = value;
		else if (key === "FNF") current.functions[1] = value;
	}
	const files = new Map();
	for (const [file, list] of records) {
		files.set(file, {
			lines: mergeCounters(list, "lines", "numbered"),
			branches: bestCounters(list.map((record) => record.branches)),
			functions: mergeCounters(list, "functions", "named"),
		});
	}
	return files;
}

function keepMax(map, key, hits) {
	map.set(key, Math.max(map.get(key) ?? 0, hits));
}

function bestCounters(counters) {
	return counters.reduce((a, b) => (b[1] > a[1] || (b[1] === a[1] && b[0] > a[0]) ? b : a));
}

/** Merges keyed hits (max per key), retaining larger totals from records without keys. */
function mergeCounters(list, metric, keyed) {
	const merged = new Map();
	for (const record of list) {
		for (const [key, hits] of record[keyed]) keepMax(merged, key, hits);
	}
	if (merged.size === 0) return bestCounters(list.map((record) => record[metric]));
	return bestCounters([
		[[...merged.values()].filter((hits) => hits > 0).length, merged.size],
		...list.filter((record) => record[keyed].size === 0).map((record) => record[metric]),
	]);
}

export function percent([hit, total]) {
	return total === 0 ? 100 : Math.round((hit / total) * 1000) / 10;
}

/** Returns config problems: utils files that are unclassified, listed twice or stale, and ungated entries without a reason. */
export function classificationProblems(config, utilsFiles, exists) {
	const problems = [];
	const gated = config.gated ?? [];
	const ungated = config.ungated ?? {};
	const seen = new Set();
	for (const file of gated) {
		if (seen.has(file) || file in ungated) problems.push(`${file} is listed more than once`);
		seen.add(file);
	}
	for (const [file, reason] of Object.entries(ungated)) {
		if (!String(reason ?? "").trim()) problems.push(`${file} is ungated without a reason`);
	}
	for (const file of utilsFiles) {
		if (!seen.has(file) && !(file in ungated)) {
			problems.push(`${file} is not classified in scripts/quality/coverage-config.json (add it to gated or ungated)`);
		}
	}
	for (const file of [...gated, ...Object.keys(ungated)]) {
		if (!exists(file)) problems.push(`${file} is listed in coverage-config.json but does not exist`);
	}
	return problems;
}

/** Applies thresholds to measured files and builds the summary consumed by CI and PR reports. */
export function buildSummary(config, measured) {
	const perFile = { ...config.thresholds.perFile };
	const aggregate = { lines: [0, 0], branches: [0, 0], functions: [0, 0] };
	const files = [];
	for (const file of config.gated) {
		const counters = measured.get(file) ?? { lines: [0, 0], branches: [0, 0], functions: [0, 0] };
		const thresholds = config.overrides?.[file] ?? perFile;
		const values = {};
		const failures = [];
		for (const metric of ["lines", "branches", "functions"]) {
			values[metric] = percent(counters[metric]);
			aggregate[metric][0] += counters[metric][0];
			aggregate[metric][1] += counters[metric][1];
			const min = thresholds[metric];
			if (min !== undefined && values[metric] < min) {
				failures.push(`${metric} ${values[metric]}% < ${min}%`);
			}
		}
		if (!measured.has(file)) failures.push("no coverage recorded");
		files.push({ file, ...values, thresholds, passed: failures.length === 0, failures });
	}
	const aggregateValues = {};
	const aggregateFailures = [];
	for (const metric of ["lines", "branches", "functions"]) {
		aggregateValues[metric] = percent(aggregate[metric]);
		const min = config.thresholds.aggregate[metric];
		if (min !== undefined && aggregateValues[metric] < min) {
			aggregateFailures.push(`aggregate ${metric} ${aggregateValues[metric]}% < ${min}%`);
		}
	}
	return {
		aggregate: {
			...aggregateValues,
			thresholds: config.thresholds.aggregate,
			passed: aggregateFailures.length === 0,
			failures: aggregateFailures,
		},
		files,
		passed: aggregateFailures.length === 0 && files.every((entry) => entry.passed),
	};
}
