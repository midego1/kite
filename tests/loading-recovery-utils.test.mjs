import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-loading-recovery-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/components/loading-recovery-utils.ts")],
	outfile: join(bundleDirectory, "recovery.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	absWorkingDir: root,
	logLevel: "silent",
});
const { loadingRecoveryDelay } = await import(pathToFileURL(join(bundleDirectory, "recovery.mjs")).href);

test("Reload Kite is offered 15 seconds after the page started, however often the startup screen remounts", () => {
	assert.equal(loadingRecoveryDelay(0), 15_000);
	assert.equal(loadingRecoveryDelay(4_000), 11_000);
	// A screen mounted again late in a stalled start does not wait another 15 seconds.
	assert.equal(loadingRecoveryDelay(14_900), 100);
	assert.equal(loadingRecoveryDelay(40_000), 0);
	assert.equal(loadingRecoveryDelay(Number.NaN), 15_000);
});
