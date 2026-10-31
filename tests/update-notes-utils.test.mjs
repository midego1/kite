import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-update-notes-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/changelog/update-notes-utils.ts")],
	outfile: join(bundleDirectory, "update-notes.mjs"),
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
const { UPDATE_NOTES_MAX_RELEASES, firstUpdateNoteLine, pickUpdateNotes } = await import(
	pathToFileURL(join(bundleDirectory, "update-notes.mjs")).href
);

const release = (name, items = [`${name} note`]) => ({ name, date: null, sections: [{ title: "Added", items }] });
const RELEASES = [release("Unreleased", []), release("4"), release("3"), release("2"), release("1"), release("0")];

test("a tab gets the releases above its own, newest first", () => {
	assert.deepEqual(
		pickUpdateNotes(RELEASES, "2").map((entry) => entry.name),
		["4", "3"],
	);
	// "Unreleased" without entries is left out; with entries it is the newest note.
	const withFragments = [release("Unreleased", ["fragment"]), ...RELEASES.slice(1)];
	assert.deepEqual(
		pickUpdateNotes(withFragments, "4").map((entry) => entry.name),
		["Unreleased"],
	);
	assert.deepEqual(pickUpdateNotes(RELEASES, "4"), []);
});

test("a tab far behind gets the newest few, and an unknown release gets none", () => {
	assert.equal(pickUpdateNotes(RELEASES, "0").length, UPDATE_NOTES_MAX_RELEASES);
	assert.equal(pickUpdateNotes(RELEASES, "0")[0].name, "4");
	assert.deepEqual(pickUpdateNotes(RELEASES, "development"), []);
	assert.deepEqual(pickUpdateNotes(RELEASES, "9"), []);
});

test("the first note line is plain text", () => {
	assert.equal(
		firstUpdateNoteLine([release("4", ["Use `via:` in [Search](/search) **now**."])]),
		"Use via: in Search now.",
	);
	assert.equal(firstUpdateNoteLine([]), "");
	assert.equal(firstUpdateNoteLine([release("4", [])]), "");
});
