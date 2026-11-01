import assert from "node:assert/strict";
import { after, test } from "node:test";
import { build } from "esbuild";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = process.cwd();
const directory = makeBundleDirectory("kite-body-batches-test-");
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/messages/body-batches.ts")],
	outfile: join(directory, "batches.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	tsconfig: join(root, "tsconfig.json"),
	absWorkingDir: root,
	logLevel: "silent",
});
const { withStoredBodies } = await import(pathToFileURL(join(directory, "batches.mjs")).href);
await build({
	entryPoints: [join(root, "src/lib/messages/body-batch-utils.ts")],
	outfile: join(directory, "utils.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	logLevel: "silent",
});
const { planBodyBatches } = await import(pathToFileURL(join(directory, "utils.mjs")).href);

const MB = 1024 * 1024;
/** A stored message row is at most about 0.5 MB (450 KB text, 16 KB HTML, headers); 1.35 MB before migration 0074. */
const REAL_ROW = 470 * 1024;

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
	assert.deepEqual(planBodyBatches(rows, 8 * MB, 2), [["m0", "m1"], ["m2", "m3"], ["m4"]]);
	assert.deepEqual(planBodyBatches([]), []);
});

test("200 real-sized rows keep every batch under 10 MB and lose no row", () => {
	const rows = Array.from({ length: 200 }, (_, i) => ({ id: `m${i}`, bodyBytes: REAL_ROW }));
	const batches = planBodyBatches(rows);
	assert.deepEqual(
		batches.flat(),
		rows.map((row) => row.id),
	);
	for (const batch of batches) assert.ok(batch.length * REAL_ROW <= 10 * MB, `${batch.length} rows`);
	// Pre-0074 rows with 1.35 MB of inline HTML, and the 2 MB D1 row cap, still stay inside the budget plus one row.
	for (const size of [1.35 * MB, 2 * MB]) {
		const wide = Array.from({ length: 100 }, (_, i) => ({ id: `w${i}`, bodyBytes: size }));
		for (const batch of planBodyBatches(wide)) assert.ok(batch.length * size <= 8 * MB + size);
	}
});

function fakeDb(stored) {
	const batches = [];
	return {
		batches,
		select: () => ({
			from: () => ({
				where: async (condition) => {
					const ids = condition.queryChunks.flatMap((chunk) => (Array.isArray(chunk) ? chunk.map((c) => c.value) : []));
					batches.push(ids);
					return stored.filter((row) => ids.includes(row.id));
				},
			}),
		}),
	};
}

test("bodies come back in row order and a row deleted in between is dropped", async () => {
	const db = fakeDb([
		{ id: "a", textBody: "text a", htmlBody: null },
		{ id: "c", textBody: null, htmlBody: "<p>c</p>" },
	]);
	const rows = [
		{ id: "a", subject: "A", bodyBytes: 6 },
		{ id: "b", subject: "B", bodyBytes: 6 },
		{ id: "c", subject: "C", bodyBytes: 8 },
	];
	assert.deepEqual(await withStoredBodies(db, rows), [
		{ id: "a", subject: "A", textBody: "text a", htmlBody: null },
		{ id: "c", subject: "C", textBody: null, htmlBody: "<p>c</p>" },
	]);
	assert.deepEqual(await withStoredBodies(fakeDb([]), []), []);
});
