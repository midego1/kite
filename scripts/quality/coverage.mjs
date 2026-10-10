import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildSummary, classificationProblems, parseLcov } from "./coverage-utils.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
process.chdir(root);
const configPath = process.env.COVERAGE_CONFIG ?? "scripts/quality/coverage-config.json";
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const outDir = "test-results/coverage";
const lcovPath = path.join(outDir, "app.lcov");

function listUtilsFiles(dir) {
	const found = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) found.push(...listUtilsFiles(full));
		else if (entry.name.endsWith("-utils.ts")) found.push(full.split(path.sep).join("/"));
	}
	return found.sort();
}

const problems = classificationProblems(config, listUtilsFiles("src/lib"), fs.existsSync);
if (problems.length) {
	console.error(`Coverage config problems:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
	process.exit(1);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const tests = fs
	.readdirSync("tests")
	.filter((name) => name.endsWith(".test.mjs"))
	.sort()
	.map((name) => `tests/${name}`);
// One coverage run per test file: a single `node --test` run merges the
// coverage of every child process into one record per source path, and that
// merge depends on the order the child coverage files are read, so a module
// bundled (but not called) by one test can erase the hits of another.
// parseLcov merges the per-file records order-independently instead.
// Each run's spec reporter prints its own partial coverage table; only the merged gate below is meaningful.
function withoutCoverageTable(text) {
	return text.replace(/^.*start of coverage report[\s\S]*?end of coverage report.*\n?/gm, "");
}

function runCoverage(test, index) {
	const lcov = path.join(outDir, "runs", `${index}.lcov`);
	const child = spawn(
		process.execPath,
		[
			"--enable-source-maps",
			"--experimental-test-coverage",
			"--test-reporter=spec",
			"--test-reporter-destination=stdout",
			"--test-reporter=lcov",
			`--test-reporter-destination=${lcov}`,
			"--test",
			test,
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	const output = [];
	child.stdout.on("data", (chunk) => output.push(chunk));
	child.stderr.on("data", (chunk) => output.push(chunk));
	return new Promise((resolve) => {
		child.on("close", (code) => {
			process.stdout.write(withoutCoverageTable(Buffer.concat(output).toString("utf8")));
			resolve({ test, code, lcov });
		});
	});
}

async function runAll() {
	const results = [];
	let next = 0;
	const worker = async () => {
		while (next < tests.length) {
			const index = next++;
			results[index] = await runCoverage(tests[index], index);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, os.availableParallelism() - 1) }, worker));
	return results;
}

fs.mkdirSync(path.join(outDir, "runs"), { recursive: true });
const results = await runAll();
const failed = results.filter((result) => result.code !== 0);
if (failed.length) {
	console.error(
		`App unit tests failed in ${failed.map((result) => result.test).join(", ")}; coverage was not evaluated.`,
	);
	process.exit(1);
}
const lcovText = results.map((result) => fs.readFileSync(result.lcov, "utf8")).join("\n");
fs.writeFileSync(lcovPath, lcovText);

const measured = parseLcov(lcovText, { root });
const summary = buildSummary(config, measured);
fs.writeFileSync(path.join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

const { aggregate } = summary;
console.log(
	`\nApp coverage (gated files): lines ${aggregate.lines}%, branches ${aggregate.branches}%, functions ${aggregate.functions}%`,
);
for (const entry of summary.files) {
	console.log(
		`  ${entry.passed ? "ok  " : "FAIL"} ${entry.file}: lines ${entry.lines}% branches ${entry.branches}% functions ${entry.functions}%`,
	);
}
const failures = [
	...aggregate.failures,
	...summary.files.flatMap((entry) => entry.failures.map((failure) => `${entry.file}: ${failure}`)),
];
if (failures.length) {
	console.error(`\nCoverage thresholds not met:\n${failures.map((failure) => `  - ${failure}`).join("\n")}`);
	process.exit(1);
}
