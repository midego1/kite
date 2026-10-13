// Splits the Playwright suite into shards of similar duration. Playwright's own `--shard` splits by test
// count, and our tests range from 0.1 s to over a minute, so one shard always ended up doing most of the work.

const SEPARATOR = " › ";

/** `E2E_SHARD=2/8` → `{ current: 2, total: 8 }`. */
export function parseShard(value) {
	const match = /^(\d+)\/(\d+)$/.exec(String(value ?? "").trim());
	if (!match) throw new Error(`E2E_SHARD must look like 2/8, got "${value ?? ""}"`);
	const current = Number(match[1]);
	const total = Number(match[2]);
	if (current < 1 || total < 1 || current > total) throw new Error(`Invalid E2E_SHARD: ${value}`);
	return { current, total };
}

/** A file opts into splitting per test with a top-level `test.describe.configure({ mode: "parallel" })`. */
export function isParallelFile(source) {
	return /^test\.describe\.configure\(\s*\{\s*mode:\s*["']parallel["']\s*\}\s*\)/m.test(source);
}

function assertUsableTitle(title, file) {
	// `--test-list` splits lines on "›" and trims every part, so such titles could never be selected.
	if (title.includes("›") || title !== title.trim())
		throw new Error(`Test title cannot be sharded (contains "›" or surrounding spaces): ${file}: "${title}"`);
}

/** Flattens a Playwright JSON report (from `--list` or a real run) into one entry per test and project. */
export function collectTests(report) {
	const tests = [];
	const walk = (suite, file, titles) => {
		for (const spec of suite.specs ?? []) {
			assertUsableTitle(spec.title, file);
			const titlePath = [...titles, spec.title];
			for (const test of spec.tests ?? []) {
				const results = test.results ?? [];
				tests.push({
					project: test.projectName,
					file,
					titlePath,
					key: [file, ...titlePath].join(SEPARATOR),
					durationMs: results.length ? results.at(-1).duration : undefined,
				});
			}
		}
		for (const child of suite.suites ?? []) {
			assertUsableTitle(child.title, file);
			walk(child, file, [...titles, child.title]);
		}
	};
	for (const fileSuite of report.suites ?? []) walk(fileSuite, fileSuite.file ?? fileSuite.title, []);
	return tests;
}

/** Recorded durations keyed by test, rounded to 100 ms so a refresh only shows real changes. */
export function timingsFromReports(reports) {
	const timings = {};
	for (const report of reports)
		for (const test of collectTests(report))
			if (test.durationMs !== undefined) timings[test.key] = Math.round(test.durationMs / 100) * 100;
	return Object.fromEntries(Object.entries(timings).sort(([a], [b]) => a.localeCompare(b)));
}

function median(values) {
	if (!values.length) return 1000;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

/**
 * One group per file, except files in `parallelFiles`, whose tests are grouped by title so each can go to a
 * different shard. A test without a recorded duration counts as the median, so new tests still spread out.
 */
export function buildGroups(tests, parallelFiles, timings) {
	const fallback = median(Object.values(timings));
	const groups = new Map();
	for (const test of tests) {
		const id = `[${test.project}]${SEPARATOR}${parallelFiles.has(test.file) ? test.key : test.file}`;
		const group = groups.get(id) ?? {
			id,
			project: test.project,
			file: test.file,
			titlePath: parallelFiles.has(test.file) ? test.titlePath : [],
			tests: 0,
			durationMs: 0,
		};
		group.tests += 1;
		group.durationMs += timings[test.key] ?? fallback;
		groups.set(id, group);
	}
	return [...groups.values()];
}

/** Longest group first onto the least-loaded shard. Deterministic, so every shard computes the same plan. */
export function assignShards(groups, total) {
	const shards = Array.from({ length: total }, () => ({ durationMs: 0, tests: 0, groups: [] }));
	const ordered = [...groups].sort((a, b) => b.durationMs - a.durationMs || a.id.localeCompare(b.id));
	for (const group of ordered) {
		const target = shards.reduce((best, shard) => (shard.durationMs < best.durationMs ? shard : best));
		target.groups.push(group);
		target.durationMs += group.durationMs;
		target.tests += group.tests;
	}
	return shards;
}

/** The `--test-list` file for one shard; a line without titles selects the whole file. */
export function formatTestList(groups) {
	return `${groups
		.map((group) => [`[${group.project}]`, group.file, ...group.titlePath].join(SEPARATOR))
		.sort()
		.join("\n")}\n`;
}
