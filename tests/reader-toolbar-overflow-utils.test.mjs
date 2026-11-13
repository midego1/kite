import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-reader-toolbar-overflow-test-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/components/message-actions/reader-toolbar-overflow-utils.ts")],
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});

const { readerInlineActionIds, toolbarNotesLabel } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

test("a phone's row holds Reply and Report spam only", () => {
	assert.deepEqual(readerInlineActionIds({ isMobile: true, canReplyAll: true, snoozable: true }), ["reply", "spam"]);
});

test("a wide row lists every action in priority order", () => {
	assert.deepEqual(readerInlineActionIds({ isMobile: false, canReplyAll: true, snoozable: true }), [
		"replyAll",
		"archive",
		"snooze",
		"move",
		"spam",
		"mark",
	]);
});

test("Reply all and Snooze only exist when the message can use them", () => {
	assert.deepEqual(readerInlineActionIds({ isMobile: false, canReplyAll: false, snoozable: false }), [
		"archive",
		"move",
		"spam",
		"mark",
	]);
});

test("Notes, where the conversation offers them, is the first action to move into More actions", () => {
	assert.deepEqual(readerInlineActionIds({ isMobile: true, canReplyAll: true, snoozable: true, notes: true }), [
		"reply",
		"spam",
		"notes",
	]);
	assert.deepEqual(readerInlineActionIds({ isMobile: false, canReplyAll: false, snoozable: false, notes: true }), [
		"archive",
		"move",
		"spam",
		"mark",
		"notes",
	]);
});

test("the Notes label is part of the measure key, empty without notes", () => {
	assert.equal(toolbarNotesLabel({ label: "2 notes" }), "2 notes");
	assert.equal(toolbarNotesLabel(undefined), "");
});
