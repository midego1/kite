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
const { firstUpdateNoteLine, pickUpdateNotes } = await import(
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
	assert.equal(pickUpdateNotes(RELEASES, "0").length, 3);
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

const CALENDAR = [
	release("Unreleased", ["fragment"]),
	release("2026.10.31.10"),
	release("2026.10.31.4"),
	release("2026.10.31.3"),
	release("2026.10.30.0"),
	release("2026.10.29.2"),
];

test("a tab older than every kept release gets the newest three, comparing parts as numbers", () => {
	assert.ok(CALENDAR.length >= 6);
	assert.deepEqual(
		pickUpdateNotes(CALENDAR, "2026.10.28.9").map((entry) => entry.name),
		["Unreleased", "2026.10.31.10", "2026.10.31.4"],
	);
	// .9 of the oldest kept day is newer than .2, so it is not "older than all": unknown, so nothing.
	assert.deepEqual(pickUpdateNotes(CALENDAR, "2026.10.29.9"), []);
	// .10 follows .4: a tab on .4 gets only what is above it.
	assert.deepEqual(
		pickUpdateNotes(CALENDAR, "2026.10.31.4").map((entry) => entry.name),
		["Unreleased", "2026.10.31.10"],
	);
});

test("a rolled-back server and a development build give no notes", () => {
	assert.deepEqual(pickUpdateNotes(CALENDAR, "2026.11.01.0"), []);
	assert.deepEqual(pickUpdateNotes(CALENDAR, "development"), []);
	assert.deepEqual(pickUpdateNotes([release("Unreleased")], "2026.10.28.0"), []);
});

test("the preview line of a note with a screenshot is its text alone", () => {
	const notes = [release("5", ["The command center has cards. ![Command center](/changelog/a.webp)"])];
	assert.equal(firstUpdateNoteLine(notes), "The command center has cards.");
});
