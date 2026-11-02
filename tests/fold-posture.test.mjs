import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import vm from "node:vm";
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
	height: 900,
	coarsePointer: false,
	segmented: false,
	legacySpanned: false,
	...overrides,
});

test("a narrow screen is folded, a touch tablet is unfolded and a fine-pointer window is desktop", () => {
	assert.equal(helpers.resolveBaseFoldPosture(base({ width: 390 })), "folded");
	assert.equal(helpers.resolveBaseFoldPosture(base({ width: 700 })), "folded");
	assert.equal(helpers.resolveBaseFoldPosture(base({ width: 720, coarsePointer: true })), "unfolded");
	assert.equal(helpers.resolveBaseFoldPosture(base({ width: 884, height: 1104, coarsePointer: true })), "unfolded");
	assert.equal(helpers.resolveBaseFoldPosture(base({ width: 1440 })), "desktop");
});

test("a narrow desktop window with a mouse stays desktop instead of splitting", () => {
	for (const width of [701, 884, 1023]) assert.equal(helpers.resolveBaseFoldPosture(base({ width })), "desktop");
});

test("a phone held sideways is folded, not a two-pane tablet", () => {
	for (const [width, height] of [
		[844, 390],
		[932, 430],
		[915, 412],
	]) {
		assert.equal(helpers.resolveBaseFoldPosture(base({ width, height, coarsePointer: true })), "folded");
	}
	// A real fold reports its segments even when the visible height is short.
	assert.equal(
		helpers.resolveBaseFoldPosture(base({ width: 900, height: 400, coarsePointer: true, segmented: true })),
		"unfolded",
	);
	// A mouse window that happens to be short is still a desktop window.
	assert.equal(helpers.resolveBaseFoldPosture(base({ width: 1200, height: 400 })), "desktop");
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

test("a folded screen has one pane and a desktop keeps the old preference from the desktop width up", () => {
	for (const preference of ["none", "right", "below"]) {
		assert.equal(helpers.resolveFoldReadingPane(preference, "folded", true), "none");
		assert.equal(helpers.resolveFoldReadingPane(preference, "desktop", true), preference);
		assert.equal(helpers.resolveFoldReadingPane(preference, "desktop", false), "none");
	}
});

test("an unfolded screen keeps the reading-pane choice, and Always two panes never shows one pane", () => {
	for (const preference of ["none", "right", "below"]) {
		assert.equal(helpers.resolveFoldReadingPane(preference, "unfolded", false), preference);
		assert.equal(helpers.resolveFoldReadingPane(preference, "unfolded", true, "auto"), preference);
		assert.equal(
			helpers.resolveFoldReadingPane(preference, "unfolded", false, "two"),
			preference === "none" ? "right" : preference,
		);
	}
});

test("the head script and the hook decide the posture alike", () => {
	const widths = [320, 390, 700, 701, 768, 884, 1023, 1024, 1090, 1100, 1440];
	const heights = [390, 500, 501, 900, 1104];
	for (const override of [null, "auto", "single", "two"]) {
		for (const coarsePointer of [false, true]) {
			for (const segmented of [false, true]) {
				for (const legacySpanned of [false, true]) {
					for (const width of widths) {
						for (const height of heights) {
							const attributes = {};
							const queries = new Set();
							if (coarsePointer) queries.add(helpers.COARSE_POINTER_QUERY);
							if (segmented) queries.add(helpers.VIEWPORT_SEGMENTS_QUERY);
							if (legacySpanned) queries.add(helpers.LEGACY_SCREEN_SPANNING_QUERY);
							const window = {
								innerWidth: width,
								innerHeight: height,
								matchMedia: (query) => ({ matches: queries.has(query) }),
								localStorage: { getItem: () => override },
							};
							vm.runInNewContext(helpers.foldPostureBootstrapScript, {
								window,
								localStorage: window.localStorage,
								document: { documentElement: { setAttribute: (name, value) => (attributes[name] = value) } },
							});
							const expected = helpers.resolveFoldPosture(
								helpers.resolveBaseFoldPosture({ width, height, coarsePointer, segmented, legacySpanned }),
								override ?? "auto",
							);
							assert.equal(
								attributes["data-fold-posture"],
								expected,
								`${width}x${height} coarse=${coarsePointer} segmented=${segmented} spanned=${legacySpanned} override=${override}`,
							);
						}
					}
				}
			}
		}
	}
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
