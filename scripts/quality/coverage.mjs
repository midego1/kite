import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
	.map((name) => `tests/${name}`);
const run = spawnSync(
	process.execPath,
	[
		"--enable-source-maps",
		"--experimental-test-coverage",
		"--test-reporter=spec",
		"--test-reporter-destination=stdout",
		"--test-reporter=lcov",
		`--test-reporter-destination=${lcovPath}`,
		"--test",
		...tests,
	],
	{ stdio: "inherit" },
);
if (run.status !== 0) {
	console.error("App unit tests failed; coverage was not evaluated.");
	process.exit(run.status ?? 1);
}

const measured = parseLcov(fs.readFileSync(lcovPath, "utf8"), { root });
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
