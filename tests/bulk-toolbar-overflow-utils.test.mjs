import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-bulk-toolbar-overflow-test-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/components/messages/bulk-toolbar-overflow-utils.ts")],
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});

const { packToolbarActions, TOOLBAR_GAP_PX } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

const items = [
	{ id: "trash", width: 80 },
	{ id: "archive", width: 90 },
	{ id: "markRead", width: 110 },
	{ id: "deleteForever", width: 120 },
	{ id: "spam", width: 110 },
	{ id: "moveTo", width: 100 },
];

test("everything fits in a wide enough row", () => {
	const visible = packToolbarActions(2000, 200, TOOLBAR_GAP_PX, items);
	assert.deepEqual([...visible], items.map((item) => item.id));
});

test("nothing fits once the reserved cluster alone exceeds the available width", () => {
	const visible = packToolbarActions(150, 200, TOOLBAR_GAP_PX, items);
	assert.deepEqual([...visible], []);
});

test("packs items in priority order and stops at the first that does not fit", () => {
	// Room for reserved (200) + trash (80) + gap + archive (90) = 378, not quite markRead (110) too.
	const visible = packToolbarActions(385, 200, TOOLBAR_GAP_PX, items);
	assert.deepEqual([...visible], ["trash", "archive"]);
});

test("a lower-priority item is never shown ahead of a higher one that did not fit", () => {
	// Even with room for everything after trash, trash not fitting stops the whole packing.
	const wideButNotTrash = [{ id: "trash", width: 10_000 }, ...items.slice(1)];
	const visible = packToolbarActions(2000, 200, TOOLBAR_GAP_PX, wideButNotTrash);
	assert.deepEqual([...visible], []);
});

test("an item landing exactly on the budget's edge is included, one pixel short it is not", () => {
	// budget = availableWidth - reserved(100); the lone item (width 80, no gap before the first item) needs
	// exactly budget === 80.
	const exact = packToolbarActions(180, 100, TOOLBAR_GAP_PX, items.slice(0, 1));
	assert.deepEqual([...exact], ["trash"]);
	const oneShort = packToolbarActions(179, 100, TOOLBAR_GAP_PX, items.slice(0, 1));
	assert.deepEqual([...oneShort], []);
});

test("an unmeasured item (width 0, not yet laid out) is treated as free and included", () => {
	const visible = packToolbarActions(500, 0, TOOLBAR_GAP_PX, [{ id: "pending", width: 0 }]);
	assert.deepEqual([...visible], ["pending"]);
});
