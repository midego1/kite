import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

// import.meta.resolve (plain strings in bundleModules's export list are invisible to it) lets knip see this test
// uses filter-utils.ts, so its exports below are not reported as dead code.
void import.meta.resolve("../src/lib/semantic/filter-utils.ts");

const { vectorKeyFor, chunkVectorId, parseChunkVectorId, groupMailboxIdsForFilter, MAX_VECTOR_ID_BYTES } =
	await bundleModules("kite-semantic-filter-", [
		[
			"vectorKeyFor, chunkVectorId, parseChunkVectorId, groupMailboxIdsForFilter, MAX_VECTOR_ID_BYTES",
			"src/lib/semantic/filter-utils.ts",
		],
	]);

test("vectorKeyFor is the first 32 hex characters of SHA-256 of the message id, deterministic and stable across lengths", async () => {
	const key = await vectorKeyFor("msg_abc123");
	assert.match(key, /^[0-9a-f]{32}$/);
	assert.equal(key, await vectorKeyFor("msg_abc123"));
	assert.notEqual(key, await vectorKeyFor("msg_abc124"));
	// Whatever the message id's own length, the key is fixed at 32 hex characters.
	const longId = await vectorKeyFor("msg_" + "x".repeat(500));
	assert.equal(longId.length, 32);
});

test("chunk vector ids round-trip through parseChunkVectorId and stay under the byte limit", async () => {
	const key = await vectorKeyFor("msg_abc123");
	for (const chunk of [0, 1, 7]) {
		const id = chunkVectorId(key, chunk);
		assert.ok(new TextEncoder().encode(id).length <= MAX_VECTOR_ID_BYTES);
		assert.deepEqual(parseChunkVectorId(id), { key, chunk });
	}
	assert.equal(parseChunkVectorId("not-a-chunk-id"), null);
	assert.equal(parseChunkVectorId(`${key}:not-a-number`), null);
});

test("mailbox ids are grouped under the per-group count and the Vectorize filter byte limit", () => {
	const ids = Array.from({ length: 100 }, (_, index) => `mailbox_${String(index).padStart(4, "0")}`);
	const groups = groupMailboxIdsForFilter(ids, { maxIdsPerGroup: 40 });
	assert.ok(groups.length >= 3);
	for (const group of groups) assert.ok(group.length <= 40);
	// Every id appears in exactly one group, in order, with none lost or duplicated.
	assert.deepEqual(groups.flat(), ids);
});

test("a byte limit smaller than the count limit still splits groups", () => {
	const ids = Array.from({ length: 20 }, (_, index) => `mailbox-with-a-fairly-long-identifier-${index}`);
	const groups = groupMailboxIdsForFilter(ids, { maxIdsPerGroup: 40, maxFilterBytes: 300 });
	assert.ok(groups.length > 1);
	for (const group of groups) {
		const bytes = new TextEncoder().encode(JSON.stringify({ mailboxId: { $in: group } })).length;
		assert.ok(bytes <= 300, `group of ${group.length} ids was ${bytes} bytes`);
	}
	assert.deepEqual(groups.flat(), ids);
});

test("duplicate mailbox ids are not repeated across groups, and an empty list makes no groups", () => {
	assert.deepEqual(groupMailboxIdsForFilter(["a", "b", "a", "b"]), [["a", "b"]]);
	assert.deepEqual(groupMailboxIdsForFilter([]), []);
});
