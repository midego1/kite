import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-bulk-action-batch-test-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/components/messages/bulk-action-batch-utils.ts")],
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});

const { chunkArray, mergeBulkResponses, BULK_ACTION_BATCH_SIZE } = await import(
	pathToFileURL(join(outDir, "entry.mjs")).href
);

test("chunkArray splits into bounded batches, the last one carrying the remainder", () => {
	const ids = Array.from({ length: 101 }, (_, index) => `m${index}`);
	const chunks = chunkArray(ids, 50);
	assert.equal(chunks.length, 3);
	assert.equal(chunks[0].length, 50);
	assert.equal(chunks[1].length, 50);
	assert.equal(chunks[2].length, 1);
	assert.deepEqual(chunks.flat(), ids);
});

test("chunkArray returns no batches for nothing, and one for less than a full batch", () => {
	assert.deepEqual(chunkArray([], 50), []);
	assert.deepEqual(chunkArray(["a", "b"], 50), [["a", "b"]]);
});

test("the bulk action batch size matches what Delete forever already uses", () => {
	assert.equal(BULK_ACTION_BATCH_SIZE, 50);
});

test("mergeBulkResponses concatenates undo, moved and reports across every batch", () => {
	const merged = mergeBulkResponses([
		{ ok: true, undo: [{ id: "a", status: "received", folderId: null }], moved: ["a"] },
		{ ok: true, undo: [{ id: "b", status: "received", folderId: null }], moved: ["b"] },
	]);
	assert.deepEqual(
		merged.undo.map((state) => state.id),
		["a", "b"],
	);
	assert.deepEqual(merged.moved, ["a", "b"]);
});

test("mergeBulkResponses carries trainingUndoUnavailable and superseded across batches", () => {
	const merged = mergeBulkResponses([
		{ ok: true, undo: [], moved: [] },
		{ ok: true, undo: [], moved: [], trainingUndoUnavailable: true, superseded: 2 },
		{ ok: true, undo: [], moved: [], superseded: 1 },
	]);
	assert.equal(merged.trainingUndoUnavailable, true);
	assert.equal(merged.superseded, 3);
});

test("mergeBulkResponses is false only when a batch answered false, and empty for no batches", () => {
	assert.equal(mergeBulkResponses([{ ok: true }, { ok: false }]).ok, false);
	assert.equal(mergeBulkResponses([{ ok: true }, { ok: true }]).ok, true);
	assert.deepEqual(mergeBulkResponses([]), { ok: true });
});

test("a single response is returned exactly as it came, so no field the merge does not know about is dropped", () => {
	const response = {
		ok: true,
		undo: [],
		moved: ["a"],
		draftsDeleted: 2,
		draftsRefused: 1,
		sendPendingRefused: 3,
		drafts: 4,
		code: "DRAFTS_NEED_CONFIRMATION",
	};
	assert.equal(mergeBulkResponses([response]), response);
});

test("mergeBulkResponses sums the drafts and send-pending counts a batch can carry", () => {
	const merged = mergeBulkResponses([
		{ ok: true, deleted: 10, skipped: 1, draftsDeleted: 2, draftsRefused: 1, sendPendingRefused: 1 },
		{ ok: true, deleted: 5, skipped: 0, draftsDeleted: 0, draftsRefused: 2, sendPendingRefused: 0 },
	]);
	assert.equal(merged.deleted, 15);
	assert.equal(merged.skipped, 1);
	assert.equal(merged.draftsDeleted, 2);
	assert.equal(merged.draftsRefused, 3);
	assert.equal(merged.sendPendingRefused, 1);
});
