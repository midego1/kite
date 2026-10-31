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
const { findChordMatch, findSequenceMatch, isBrowserChord, isModifierKey } = await import(
	pathToFileURL(join(bundleDirectory, "entry.mjs")).href
);

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

test("a bare key is handled only when no Cmd, Ctrl or Alt chord is held", () => {
	const press = (key, modifiers = {}) =>
		isBrowserChord({ key, metaKey: false, ctrlKey: false, altKey: false, ...modifiers });
	assert.equal(press("c", { metaKey: true }), true);
	assert.equal(press("c", { ctrlKey: true }), true);
	assert.equal(press("c", { altKey: true }), true);
	assert.equal(press("c"), false);
	assert.equal(press("?"), false);
	// Cmd and Ctrl alone never type a character, even a symbol.
	assert.equal(press("?", { metaKey: true }), true);
	assert.equal(press("/", { ctrlKey: true }), true);
	assert.equal(press("#", { metaKey: true, altKey: true }), true);
	// AltGr (Ctrl+Alt) and Option type symbols; letters, digits and space with them stay chords.
	assert.equal(press("#", { ctrlKey: true, altKey: true }), false);
	assert.equal(press("€", { ctrlKey: true, altKey: true }), false);
	assert.equal(press("#", { altKey: true }), false);
	assert.equal(press("ą", { ctrlKey: true, altKey: true }), true);
	assert.equal(press("3", { altKey: true }), true);
	assert.equal(press(" ", { altKey: true }), true);
	assert.equal(press("F4", { altKey: true }), true);
});

test("a Cmd/Ctrl chord matches only the modifiers its shortcut names", () => {
	const print = { key: "p", modifiers: ["meta", "ctrl"] };
	const macOnly = { key: "s", modifiers: ["meta"] };
	const ctrlOnly = { key: "l", modifiers: ["ctrl"] };
	const shifted = { key: "z", modifiers: ["ctrl", "shift"] };
	const bare = { key: "e" };
	const list = [bare, print, macOnly, ctrlOnly, shifted];
	const chord = (key, modifiers = {}) =>
		findChordMatch({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers }, list);
	assert.equal(chord("p", { ctrlKey: true }), print);
	assert.equal(chord("P", { metaKey: true }), print);
	// Ctrl+Shift+P opens a private window in Firefox and Alt chords type characters: both stay the browser's.
	assert.equal(chord("p", { ctrlKey: true, shiftKey: true }), undefined);
	assert.equal(chord("p", { ctrlKey: true, altKey: true }), undefined);
	assert.equal(chord("p"), undefined);
	assert.equal(chord("s", { metaKey: true }), macOnly);
	assert.equal(chord("s", { ctrlKey: true }), undefined);
	assert.equal(chord("l", { ctrlKey: true }), ctrlOnly);
	assert.equal(chord("l", { metaKey: true }), undefined);
	assert.equal(chord("z", { ctrlKey: true, shiftKey: true }), shifted);
	assert.equal(chord("z", { ctrlKey: true }), undefined);
	assert.equal(chord("e", { ctrlKey: true }), undefined);
	assert.equal(
		findChordMatch({ key: "x", metaKey: false, ctrlKey: true, altKey: false, shiftKey: false }, [
			{ key: "x", modifiers: ["alt", "ctrl"] },
		]),
		undefined,
	);
});
