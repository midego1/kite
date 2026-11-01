import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const directory = await mkdtemp(join(tmpdir(), "mbox-utils-"));
await build({
	entryPoints: [join(root, "src/lib/messages/body-batch-utils.ts")],
	outfile: join(directory, "utils.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	logLevel: "silent",
});
const { planBodyBatches } = await import(pathToFileURL(join(directory, "utils.mjs")).href);

test("batches stay within the byte budget, in order", () => {
	const rows = [3, 3, 3, 3].map((bodyBytes, i) => ({ id: `m${i}`, bodyBytes }));
	assert.deepEqual(planBodyBatches(rows, 7, 50), [
		["m0", "m1"],
		["m2", "m3"],
	]);
});

test("a row over the budget gets its own batch", () => {
	const rows = [
		{ id: "a", bodyBytes: 1 },
		{ id: "big", bodyBytes: 100 },
		{ id: "b", bodyBytes: 1 },
	];
	assert.deepEqual(planBodyBatches(rows, 10, 50), [["a"], ["big"], ["b"]]);
});

test("batches never exceed the id limit", () => {
	const rows = Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, bodyBytes: 0 }));
	assert.deepEqual(planBodyBatches(rows, 10 * 1024 * 1024, 2), [["m0", "m1"], ["m2", "m3"], ["m4"]]);
	assert.deepEqual(planBodyBatches([]), []);
});

test("worst case: 2 MB rows stay under 50 MB per batch", () => {
	const rows = Array.from({ length: 100 }, (_, i) => ({ id: `m${i}`, bodyBytes: 2 * 1024 * 1024 }));
	for (const batch of planBodyBatches(rows)) assert.ok(batch.length * 2 * 1024 * 1024 <= 10 * 1024 * 1024);
});
