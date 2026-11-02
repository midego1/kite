import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-fold-posture-test-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/components/fold-posture-utils.ts")],
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

const base = (overrides = {}) => ({
	width: 1400,
	coarsePointer: false,
	segmented: false,
	legacySpanned: false,
	...overrides,
});

test("a narrow screen is folded, a tablet is unfolded and a wide fine-pointer screen is desktop", () => {
	assert.equal(helpers.resolveBaseFoldPosture(base({ width: 390 })), "folded");
	assert.equal(helpers.resolveBaseFoldPosture(base({ width: 700 })), "folded");
	assert.equal(helpers.resolveBaseFoldPosture(base({ width: 720, coarsePointer: true })), "unfolded");
	assert.equal(helpers.resolveBaseFoldPosture(base({ width: 884, coarsePointer: true })), "unfolded");
	assert.equal(helpers.resolveBaseFoldPosture(base({ width: 884 })), "unfolded");
	assert.equal(helpers.resolveBaseFoldPosture(base({ width: 1440 })), "desktop");
});

test("viewport segments and the legacy screen-spanning query make an unfolded posture at any width", () => {
	assert.equal(helpers.resolveBaseFoldPosture(base({ width: 1440, segmented: true })), "unfolded");
	assert.equal(helpers.resolveBaseFoldPosture(base({ width: 1200, legacySpanned: true })), "unfolded");
	// A folded cover screen wins even when a stale segment list is still reported.
	assert.equal(helpers.resolveBaseFoldPosture(base({ width: 390, segmented: true })), "folded");
});

test("a coarse pointer stays unfolded up to the tablet limit, then becomes desktop", () => {
	assert.equal(helpers.resolveBaseFoldPosture(base({ width: 1090, coarsePointer: true })), "unfolded");
	assert.equal(helpers.resolveBaseFoldPosture(base({ width: 1200, coarsePointer: true })), "desktop");
});

test("the per-browser override wins over the detected posture", () => {
	assert.equal(helpers.resolveFoldPosture("desktop", "auto"), "desktop");
	assert.equal(helpers.resolveFoldPosture("desktop", "single"), "folded");
	assert.equal(helpers.resolveFoldPosture("folded", "two"), "unfolded");
	assert.equal(helpers.resolveFoldPosture("unfolded", "auto"), "unfolded");
});

test("the reading pane is single when folded, side by side when unfolded, and the old preference on desktop", () => {
	for (const posture of ["folded", "unfolded", "desktop"]) {
		assert.equal(
			helpers.resolveFoldReadingPane("below", posture, posture === "desktop"),
			posture === "unfolded" ? "right" : posture === "desktop" ? "below" : "none",
		);
	}
	assert.equal(helpers.resolveFoldReadingPane("none", "desktop", true), "none");
	assert.equal(helpers.resolveFoldReadingPane("right", "desktop", false), "none");
	assert.equal(helpers.resolveFoldReadingPane("below", "unfolded", false), "right");
});

test("viewport segments are normalised and invalid entries are dropped", () => {
	assert.deepEqual(helpers.readFoldSegments(undefined), []);
	assert.deepEqual(helpers.readFoldSegments([{ left: 0, top: 0, width: 500, height: 800 }, { nope: true }]), [
		{ left: 0, top: 0, width: 500, height: 800 },
	]);
});

test("a side-by-side fold reports the hinge between the two screens", () => {
	const segments = [
		{ left: 0, top: 0, width: 600, height: 800 },
		{ left: 620, top: 0, width: 580, height: 800 },
	];
	const hinge = helpers.foldHingeFromSegments(segments);
	assert.equal(hinge?.orientation, "vertical");
	assert.equal(hinge?.gap, 20);
	assert.deepEqual(hinge?.first, segments[0]);
	assert.deepEqual(hinge?.second, segments[1]);
});

test("a stacked fold reports a horizontal hinge, and one screen has none", () => {
	const segments = [
		{ left: 0, top: 0, width: 800, height: 500 },
		{ left: 0, top: 510, width: 800, height: 490 },
	];
	assert.equal(helpers.foldHingeFromSegments(segments)?.orientation, "horizontal");
	assert.equal(helpers.foldHingeFromSegments(segments.slice(0, 1)), null);
	assert.equal(helpers.foldHingeFromSegments([]), null);
});

test("the stored fold preference only accepts its three values", () => {
	for (const value of ["auto", "single", "two"]) assert.ok(helpers.isFoldLayoutPreference(value));
	for (const value of ["", null, "three", 2]) assert.equal(helpers.isFoldLayoutPreference(value), false);
});
