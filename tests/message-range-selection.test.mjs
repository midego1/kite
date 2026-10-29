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

const {
	getRangeSelectionIds,
	isApplePlatform,
	planRowSelection,
	replaceSelection,
	resolveSelectionAnchor,
	rowClickModifiers,
} = await import(pathToFileURL(join(outDir, "entry.mjs")).href);
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

const click = (extra = {}) => ({ button: 0, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...extra });

test("Cmd toggles on Apple devices and Ctrl elsewhere; other clicks open the message", () => {
	assert.equal(isApplePlatform("MacIntel"), true);
	assert.equal(isApplePlatform("Linux x86_64"), false);
	assert.deepEqual(rowClickModifiers(click({ metaKey: true }), true), { shift: false, toggle: true });
	assert.deepEqual(rowClickModifiers(click({ ctrlKey: true }), false), { shift: false, toggle: true });
	assert.deepEqual(rowClickModifiers(click({ shiftKey: true }), false), { shift: true, toggle: false });
	assert.deepEqual(rowClickModifiers(click({ shiftKey: true, ctrlKey: true }), false), { shift: true, toggle: true });
	assert.equal(rowClickModifiers(click(), true), null);
	// Ctrl-click is the context click on a Mac and the Windows key is no toggle; Alt and other buttons are left alone.
	assert.equal(rowClickModifiers(click({ ctrlKey: true }), true), null);
	assert.equal(rowClickModifiers(click({ metaKey: true }), false), null);
	assert.equal(rowClickModifiers(click({ altKey: true, shiftKey: true }), false), null);
	assert.equal(rowClickModifiers(click({ button: 1, shiftKey: true }), false), null);
});

test("the anchor is the last anchor still listed, else the open message", () => {
	assert.equal(resolveSelectionAnchor(ids, "b", "d"), "b");
	assert.equal(resolveSelectionAnchor(ids, "gone", "d"), "d");
	assert.equal(resolveSelectionAnchor(ids, null, "d"), "d");
	assert.equal(resolveSelectionAnchor(ids, null, "gone"), null);
	assert.equal(resolveSelectionAnchor(ids, null, undefined), null);
});

const plan = (input) => planRowSelection({ orderedIds: ids, selectedIds: [], anchorId: null, openId: null, ...input });

test("Shift-click selects from the open message to the row, and again from the same anchor", () => {
	const shift = { shift: true, toggle: false };
	const first = plan({ openId: "a", targetId: "e", modifiers: shift });
	assert.deepEqual(first, { selectedIds: ["a", "b", "c", "d", "e"], anchorId: "a" });
	// Shrinking: the range replaces the selection and the anchor stays.
	const second = plan({
		openId: "a",
		anchorId: first.anchorId,
		selectedIds: first.selectedIds,
		targetId: "c",
		modifiers: shift,
	});
	assert.deepEqual(second, { selectedIds: ["a", "b", "c"], anchorId: "a" });
	// The other direction passes over the anchor.
	const third = plan({ anchorId: "c", targetId: "a", modifiers: shift, selectedIds: second.selectedIds });
	assert.deepEqual(third.selectedIds, ["a", "b", "c"]);
});

test("Shift-click without an anchor selects the row and makes it the anchor", () => {
	assert.deepEqual(plan({ targetId: "c", modifiers: { shift: true, toggle: false } }), {
		selectedIds: ["c"],
		anchorId: "c",
	});
});

test("Cmd+Shift-click adds the range to the selection", () => {
	const result = plan({
		anchorId: "c",
		selectedIds: ["a"],
		targetId: "e",
		modifiers: { shift: true, toggle: true },
	});
	assert.deepEqual(result.selectedIds, ["a", "c", "d", "e"]);
	assert.equal(result.anchorId, "c");
});

test("Cmd-click toggles a row and makes it the anchor", () => {
	const toggle = { shift: false, toggle: true };
	const added = plan({ selectedIds: ["a"], targetId: "c", modifiers: toggle });
	assert.deepEqual(added, { selectedIds: ["a", "c"], anchorId: "c" });
	const removed = plan({ selectedIds: ["a", "c"], targetId: "a", modifiers: toggle });
	assert.deepEqual(removed, { selectedIds: ["c"], anchorId: "a" });
});

test("Cmd-click with nothing selected first adds the open message", () => {
	const toggle = { shift: false, toggle: true };
	assert.deepEqual(plan({ openId: "b", targetId: "d", modifiers: toggle }).selectedIds, ["b", "d"]);
	// A selection that already exists is not joined by the open message.
	assert.deepEqual(plan({ openId: "b", selectedIds: ["a"], targetId: "d", modifiers: toggle }).selectedIds, ["a", "d"]);
	// An open message that is not a listed row is ignored.
	assert.deepEqual(plan({ openId: "gone", targetId: "d", modifiers: toggle }).selectedIds, ["d"]);
});

test("a row that is not loaded changes nothing", () => {
	const result = plan({
		selectedIds: ["a"],
		anchorId: "a",
		targetId: "gone",
		modifiers: { shift: true, toggle: false },
	});
	assert.deepEqual(result, { selectedIds: ["a"], anchorId: "a" });
});

test("a range crossing rows that are not loaded selects the loaded ones only", () => {
	const loaded = ["a", "b", "c"];
	const result = planRowSelection({
		orderedIds: loaded,
		selectedIds: [],
		anchorId: "a",
		targetId: "c",
		modifiers: { shift: true, toggle: false },
	});
	assert.deepEqual(result.selectedIds, ["a", "b", "c"]);
});

test("replaceSelection keeps rows already selected and swaps the rest", () => {
	const messages = ids.map((id) => ({ id, read: true, mailboxId: "m1" }));
	const current = [
		{ id: "a", read: false },
		{ id: "e", read: true },
	];
	const next = replaceSelection(current, messages, ["a", "b"]);
	assert.deepEqual(
		next.map((item) => item.id),
		["a", "b"],
	);
	assert.equal(next[0].read, false);
	assert.equal(next[1].mailboxId, "m1");
});
