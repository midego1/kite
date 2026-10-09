import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-range-selection-test-");
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

const { getRangeSelectionIds } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);
const ids = ["a", "b", "c", "d", "e"];

test("Shift-click selects from the anchor to the target in list order, either direction", () => {
	assert.deepEqual(getRangeSelectionIds(ids, "b", "d"), ["b", "c", "d"]);
	assert.deepEqual(getRangeSelectionIds(ids, "d", "b"), ["b", "c", "d"]);
	assert.deepEqual(getRangeSelectionIds(ids, "c", "c"), ["c"]);
});

test("without an anchor on the page only the clicked row is used", () => {
	assert.deepEqual(getRangeSelectionIds(ids, null, "c"), ["c"]);
	assert.deepEqual(getRangeSelectionIds(ids, "gone", "c"), ["c"]);
	assert.deepEqual(getRangeSelectionIds(ids, "a", "gone"), []);
});

test("rows that left the list leave the selection, and an unchanged selection keeps its identity", async () => {
	const { pruneSelection } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);
	const selected = [
		{ id: "a", read: true },
		{ id: "b", read: false },
	];
	assert.deepEqual(pruneSelection(selected, [{ id: "a" }]), [{ id: "a", read: true }]);
	assert.equal(pruneSelection(selected, [{ id: "a" }, { id: "b" }]), selected);
});
