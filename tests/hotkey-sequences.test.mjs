import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-hotkeys-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/components/shortcuts/use-hotkeys-utils.ts")],
	outfile: join(bundleDirectory, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
});
const { findSequenceMatch, isModifierKey } = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);

const shortcuts = [{ key: "g i" }, { key: "g !" }, { key: "G S" }, { key: "e" }];

test("a sequence matches when it ends the buffer, after stray keys too", () => {
	assert.equal(findSequenceMatch(["g", "i"], shortcuts), shortcuts[0]);
	assert.equal(findSequenceMatch(["j", "g", "i"], shortcuts), shortcuts[0]);
	assert.equal(findSequenceMatch(["x", "y", "g", "!"], shortcuts), shortcuts[1]);
	assert.equal(findSequenceMatch(["g", "s"], shortcuts), shortcuts[2]);
	assert.equal(findSequenceMatch(["g"], shortcuts), undefined);
});

test("a single key matches only when it is the whole buffer", () => {
	assert.equal(findSequenceMatch(["e"], shortcuts), shortcuts[3]);
	assert.equal(findSequenceMatch(["j", "e"], shortcuts), undefined);
	assert.equal(findSequenceMatch(["g", "i", "e"], shortcuts), undefined);
	assert.equal(findSequenceMatch([], shortcuts), undefined);
});

test("modifier keys are not steps of a sequence", () => {
	for (const key of ["Shift", "control", "Alt", "meta", "AltGraph", "CapsLock"]) assert.equal(isModifierKey(key), true);
	for (const key of ["g", "!", "?", "escape"]) assert.equal(isModifierKey(key), false);
});
