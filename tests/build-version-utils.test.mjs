import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-build-version-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/build-version-utils.ts")],
	outfile: join(bundleDirectory, "build-version.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	absWorkingDir: root,
	logLevel: "silent",
});
const { formatBuildTime } = await import(pathToFileURL(join(bundleDirectory, "build-version.mjs")).href);

test("the embedded build time is rendered as a short local date and time", () => {
	const label = formatBuildTime("2026-10-12T14:20:00.000Z");
	assert.notEqual(label, "development");
	assert.match(label, /\d{1,2}:\d{2}/);
	assert.match(label, /Oct/);
});

test("a build without a recorded time reads as development", () => {
	assert.equal(formatBuildTime(undefined), "development");
	assert.equal(formatBuildTime(null), "development");
	assert.equal(formatBuildTime(""), "development");
	assert.equal(formatBuildTime("not a timestamp"), "development");
});
