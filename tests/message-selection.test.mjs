import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-message-selection-test-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/components/messages/message-range-selection-utils.ts")],
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
const { pruneSelection } = helpers;

test("pruneSelection keeps the same array when every id is still listed", () => {
	const selected = [{ id: "a", read: true }];
	assert.equal(pruneSelection(selected, [{ id: "a" }, { id: "b" }]), selected);
});

test("pruneSelection drops ids that left the list and keeps their data", () => {
	const selected = [
		{ id: "a", read: true },
		{ id: "b", read: false },
	];
	assert.deepEqual(pruneSelection(selected, [{ id: "b" }]), [{ id: "b", read: false }]);
	assert.deepEqual(pruneSelection(selected, []), []);
});

test("pruneSelection returns an empty selection unchanged", () => {
	const empty = [];
	assert.equal(pruneSelection(empty, []), empty);
});

test("applySelection adds once, removes, and marks threads with unread mail as unread", () => {
	const { applySelection } = helpers;
	const rows = [{ id: "a", read: true, threadUnread: 1 }];
	const added = applySelection([], rows, ["a"], true);
	assert.deepEqual(added, [{ id: "a", read: false }]);
	assert.deepEqual(applySelection(added, rows, ["a"], true), added);
	assert.deepEqual(applySelection(added, rows, ["a"], false), []);
});

test("applySelection over every visible row selects them and only unselects visible ones", () => {
	const { applySelection } = helpers;
	const rows = [
		{ id: "a", read: true },
		{ id: "b", read: false },
	];
	const ids = ["a", "b"];
	assert.deepEqual(applySelection([{ id: "z", read: true }], rows, ids, true), [
		{ id: "z", read: true },
		{ id: "a", read: true },
		{ id: "b", read: false },
	]);
	assert.deepEqual(applySelection([{ id: "z", read: true }, ...rows], rows, ids, false), [{ id: "z", read: true }]);
});
