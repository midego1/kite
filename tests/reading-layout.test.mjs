import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-reading-layout-test-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/components/messages/reading-layout-utils.ts")],
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});

const helpers = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

test("new users get the reading pane on the right", () => {
	assert.equal(helpers.parseReadingPaneMode(null, null), "right");
	assert.equal(helpers.DEFAULT_READING_PANE_MODE, "right");
});

test("a stored reading pane wins over the legacy two-column switch", () => {
	assert.equal(helpers.parseReadingPaneMode("below", "off"), "below");
	assert.equal(helpers.parseReadingPaneMode("none", "on"), "none");
	assert.equal(helpers.parseReadingPaneMode("right", "off"), "right");
});

test("the legacy two-column switch migrates to Right or No split", () => {
	assert.equal(helpers.parseReadingPaneMode(null, "on"), "right");
	assert.equal(helpers.parseReadingPaneMode(null, "off"), "none");
	assert.equal(helpers.parseReadingPaneMode("garbage", "off"), "none");
	assert.equal(helpers.parseReadingPaneMode("garbage", "garbage"), "right");
});

test("density falls back to Default for unknown values", () => {
	assert.equal(helpers.parseMessageListDensity(null), "default");
	assert.equal(helpers.parseMessageListDensity("tiny"), "default");
	for (const density of ["default", "comfortable", "compact"]) {
		assert.equal(helpers.parseMessageListDensity(density), density);
	}
});

test("narrow viewports always read in one column", () => {
	for (const mode of ["none", "right", "below"]) {
		assert.equal(helpers.getEffectiveReadingPaneMode(mode, false), "none");
		assert.equal(helpers.getEffectiveReadingPaneMode(mode, true), mode);
	}
});

test("list size stays between its minimum and the space left for the pane", () => {
	assert.equal(helpers.clampListSize(400, 250, 1000, 280), 400);
	assert.equal(helpers.clampListSize(900, 250, 1000, 280), 720);
	assert.equal(helpers.clampListSize(100, 250, 1000, 280), 250);
	assert.equal(helpers.clampListSize(400, 250, 300, 280), 250);
});

test("compact density hides the snippet line of stacked rows", () => {
	assert.equal(helpers.getStackedRowDensity("compact").showPreview, false);
	assert.equal(helpers.getStackedRowDensity("default").showPreview, true);
	assert.equal(helpers.getStackedRowDensity("comfortable").showPreview, true);
	const heights = ["compact", "default", "comfortable"].map(
		(density) => helpers.getWideRowDensity(density).rowClassName,
	);
	assert.equal(new Set(heights).size, 3);
});

test("every option list matches its type guard", () => {
	assert.deepEqual(
		helpers.READING_PANE_OPTIONS.map((option) => option.value),
		["none", "right", "below"],
	);
	assert.ok(helpers.READING_PANE_OPTIONS.every((option) => helpers.isReadingPaneMode(option.value)));
	assert.ok(helpers.MESSAGE_DENSITY_OPTIONS.every((option) => helpers.isMessageListDensity(option.value)));
});
