// Runs one duration-balanced slice of the e2e suite: `E2E_SHARD=2/8 npm run test:e2e:shard`
// (`-- --plan` prints the split and checks the list without running anything).
// The plan comes from `playwright test --list` and the recorded durations in e2e/timings.json
// (refresh with `npm run e2e:timings -- <playwright-results.json>...`).
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
	assignShards,
	buildGroups,
	collectTests,
	formatTestList,
	isParallelFile,
	parseShard,
} from "./e2e-shard-utils.mjs";

const run = promisify(execFile);
const PLAYWRIGHT = path.join("node_modules", ".bin", process.platform === "win32" ? "playwright.cmd" : "playwright");
const LIST_FILE = "test-results/e2e-shard-list.txt";

async function listTests(extraArgs = []) {
	const { stdout } = await run(PLAYWRIGHT, ["test", "--list", "--reporter=json", ...extraArgs], {
		maxBuffer: 64 * 1024 * 1024,
	});
	return collectTests(JSON.parse(stdout));
}

const shard = parseShard(process.env.E2E_SHARD);
const tests = await listTests();
const timings = JSON.parse(await fs.readFile("e2e/timings.json", "utf8"));
const parallelFiles = new Set();
for (const file of new Set(tests.map((test) => test.file)))
	if (isParallelFile(await fs.readFile(path.join("e2e", file), "utf8"))) parallelFiles.add(file);

const shards = assignShards(buildGroups(tests, parallelFiles, timings), shard.total);
const mine = shards[shard.current - 1];
console.log(
	shards
		.map((s, i) => `shard ${i + 1}/${shard.total}: ${s.tests} tests, ~${Math.round(s.durationMs / 1000)}s`)
		.join("\n"),
);
if (!mine.tests) {
	console.log(`Shard ${shard.current} has no tests; nothing to run.`);
	process.exit(0);
}
await fs.mkdir(path.dirname(LIST_FILE), { recursive: true });
await fs.writeFile(LIST_FILE, formatTestList(mine.groups));

// A title the list cannot select would silently drop a test, so the list must select exactly the planned tests.
const selected = await listTests(["--test-list", LIST_FILE]);
if (selected.length !== mine.tests)
	throw new Error(`${LIST_FILE} selects ${selected.length} tests, expected ${mine.tests}`);
// `--plan` stops here: the split is printed and the list checked, without starting the server.
if (process.argv.includes("--plan")) process.exit(0);

const child = spawn(PLAYWRIGHT, ["test", "--test-list", LIST_FILE], { stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
