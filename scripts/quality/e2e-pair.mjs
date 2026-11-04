// Runs two duration-balanced e2e slices side by side, each with its own server and database:
// `E2E_PAIR=2/10 npm run test:e2e:pair` runs slices 3 and 4 of 20 (`-- --plan` plans both without running anything).
// Both always finish, and the exit code fails if either did. Results go to test-results/slice-K and
// playwright-report/slice-K. The slices wait on the app rather than the CPU, which is why two fit one runner.
import { execFileSync, spawn } from "node:child_process";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { pairSlices } from "./e2e-shard-utils.mjs";

const MB = 1024 * 1024;
const SAMPLE_MS = 10_000;
const args = process.argv.slice(2);
const slices = pairSlices(process.env.E2E_PAIR, Number(process.env.E2E_PORT ?? 3200));

function runSlice({ slice, shard, port }) {
	const started = performance.now();
	const child = spawn(process.execPath, ["scripts/quality/e2e-shard.mjs", ...args], {
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, E2E_SHARD: shard, E2E_SLICE: String(slice), E2E_PORT: String(port) },
	});
	for (const stream of [child.stdout, child.stderr])
		createInterface({ input: stream }).on("line", (line) => console.log(`[slice ${slice}] ${line}`));
	return new Promise((resolve) => {
		const finish = (exitCode) =>
			resolve({ slice, exitCode, seconds: Math.round((performance.now() - started) / 1000) });
		child.on("error", (error) => {
			console.error(`[slice ${slice}] ${error.message}`);
			finish(1);
		});
		child.on("close", (code) => finish(code ?? 1));
	});
}

// The servers share these generated files, so they are written once before either starts (e2e/prepare-state.mjs).
if (!args.includes("--plan")) {
	execFileSync("node", ["scripts/generate-migration-bundle.mjs"], { stdio: "inherit" });
	execFileSync("node", ["scripts/generate-changelog-bundle.mjs"], { stdio: "inherit" });
	process.env.E2E_BUNDLES_READY = "1";
}

let lowestFree = os.freemem();
let highestLoad = 0;
const sampler = setInterval(() => {
	lowestFree = Math.min(lowestFree, os.freemem());
	highestLoad = Math.max(highestLoad, os.loadavg()[0]);
}, SAMPLE_MS);

const results = await Promise.all(slices.map(runSlice));
clearInterval(sampler);
for (const { slice, exitCode, seconds } of results)
	console.log(`e2e-pair: slice ${slice} exit ${exitCode} in ${seconds}s`);
console.log(
	`e2e-pair: lowest available memory ${Math.round(lowestFree / MB)} MB of ${Math.round(os.totalmem() / MB)} MB, ` +
		`highest 1-minute load ${highestLoad.toFixed(1)} on ${os.availableParallelism()} CPUs`,
);
process.exit(results.find((result) => result.exitCode !== 0)?.exitCode ?? 0);
