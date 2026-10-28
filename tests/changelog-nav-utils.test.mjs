import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-changelog-nav-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/changelog/changelog-nav-utils.ts")],
	outfile: join(bundleDirectory, "nav.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	absWorkingDir: root,
	packages: "external",
	logLevel: "silent",
});
const {
	estimateReleaseHeight,
	initialReleaseName,
	isCurrentRelease,
	nextNavIndex,
	pickActiveRelease,
	releaseAnchorId,
	visibleReleases,
} = await import(pathToFileURL(join(bundleDirectory, "nav.mjs")).href);

const release = (name, items = 1) => ({
	name,
	date: null,
	sections: [{ title: "Added", items: Array(items).fill("x") }],
});

test("anchor ids are stable DOM ids", () => {
	assert.equal(releaseAnchorId({ name: "2026.10.28.0" }), "release-2026-10-28-0");
	assert.equal(releaseAnchorId({ name: "Unreleased" }), "release-unreleased");
	assert.equal(releaseAnchorId({ name: "!!!" }), "release-notes");
});

test("only a named release matching the build is current", () => {
	assert.equal(isCurrentRelease({ name: "2026.10.28.0" }, "2026.10.28.0"), true);
	assert.equal(isCurrentRelease({ name: "2026.10.27.0" }, "2026.10.28.0"), false);
	assert.equal(isCurrentRelease({ name: "Unreleased" }, "Unreleased"), false);
});

test("the dialog opens on Unreleased when it has notes, else the current release, else the newest", () => {
	const named = [release("2026.10.28.0"), release("2026.10.27.0")];
	assert.equal(initialReleaseName([release("Unreleased"), ...named], "2026.10.28.0"), "Unreleased");
	assert.equal(initialReleaseName([release("Unreleased", 0), ...named], "2026.10.27.0"), "2026.10.27.0");
	assert.equal(initialReleaseName(named, "development"), "2026.10.28.0");
	assert.equal(initialReleaseName([], "development"), null);
});

test("an empty Unreleased heading is not listed", () => {
	const listed = visibleReleases([release("Unreleased", 0), release("2026.10.28.0")]);
	assert.deepEqual(
		listed.map((entry) => entry.name),
		["2026.10.28.0"],
	);
});

test("undrawn notes are taller the more they hold", () => {
	assert.ok(estimateReleaseHeight(release("a", 10)) > estimateReleaseHeight(release("b", 1)));
});

test("arrow keys step through the list without wrapping", () => {
	assert.equal(nextNavIndex("ArrowDown", 0, 3), 1);
	assert.equal(nextNavIndex("ArrowDown", 2, 3), 2);
	assert.equal(nextNavIndex("ArrowUp", 0, 3), 0);
	assert.equal(nextNavIndex("ArrowUp", 2, 3), 1);
	assert.equal(nextNavIndex("Home", 2, 3), 0);
	assert.equal(nextNavIndex("End", 0, 3), 2);
	assert.equal(nextNavIndex("a", 0, 3), null);
	assert.equal(nextNavIndex("ArrowDown", 0, 0), null);
});

test("the topmost release in the reading band is active, and the last one stays when none is", () => {
	const order = ["Unreleased", "2", "1"];
	assert.equal(pickActiveRelease(order, new Set(["1", "2"]), "Unreleased"), "2");
	assert.equal(pickActiveRelease(order, new Set(), "2"), "2");
});
