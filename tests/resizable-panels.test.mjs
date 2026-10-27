import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-resizable-panels-test-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/components/ui/resizable-utils.ts")],
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});

const { panelSyncAction, layoutPixels, pixelsPerPercent } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

test("a stored collapsed state collapses an open panel and leaves a collapsed one alone", () => {
	assert.equal(panelSyncAction({ wantCollapsed: true, wantSize: 300, collapsed: false, size: 300 }), "collapse");
	assert.equal(panelSyncAction({ wantCollapsed: true, wantSize: 300, collapsed: true, size: 72 }), "none");
});

test("a stored size expands a collapsed panel and resizes an open one that differs", () => {
	assert.equal(panelSyncAction({ wantCollapsed: false, wantSize: 300, collapsed: true, size: 72 }), "expand");
	assert.equal(panelSyncAction({ wantCollapsed: false, wantSize: 300, collapsed: false, size: 260 }), "resize");
});

test("sizes within a pixel count as already applied", () => {
	assert.equal(panelSyncAction({ wantCollapsed: false, wantSize: 300, collapsed: false, size: 300.6 }), "none");
	assert.equal(panelSyncAction({ wantCollapsed: false, wantSize: 300, collapsed: false, size: 299 }), "none");
});

test("a layout's percentages turn into pixels at the scale the panel last reported", () => {
	const scale = pixelsPerPercent({ inPixels: 360, asPercentage: 32.757 });
	assert.equal(layoutPixels(37.757, scale), 415);
	assert.equal(layoutPixels(0, scale), 0);
	assert.equal(layoutPixels(undefined, scale), 0);
	assert.equal(pixelsPerPercent({ inPixels: 0, asPercentage: 0 }), null);
});
