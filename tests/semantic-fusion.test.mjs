import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

const { reciprocalRankFusion } = await bundleModules("kite-semantic-fusion-", [
	["reciprocalRankFusion", "src/lib/semantic/fusion-utils.ts"],
]);

test("a message in both lists ranks above one in just the better-ranked list alone", () => {
	const fused = reciprocalRankFusion(["a", "b", "c"], ["b"]);
	assert.equal(fused[0].id, "b");
	assert.equal(fused[0].match, "both");
});

test("order follows 1/(60+rank) summed over both lists, 1-indexed", () => {
	const fused = reciprocalRankFusion(["a", "b"], ["c"]);
	const expected = new Map([
		["a", 1 / 61],
		["b", 1 / 62],
		["c", 1 / 61],
	]);
	for (const hit of fused) assert.ok(Math.abs(hit.score - expected.get(hit.id)) < 1e-12, hit.id);
});

test("match labels: keyword-only, meaning-only and both", () => {
	const fused = reciprocalRankFusion(["a", "b"], ["b", "c"]);
	const byId = Object.fromEntries(fused.map((hit) => [hit.id, hit.match]));
	assert.deepEqual(byId, { a: "keyword", b: "both", c: "meaning" });
});

test("a tie in score breaks by id, so the order is deterministic", () => {
	const fused = reciprocalRankFusion(["z"], ["a"]);
	assert.deepEqual(
		fused.map((hit) => hit.id),
		["a", "z"],
	);
});

test("empty lists fuse to nothing", () => {
	assert.deepEqual(reciprocalRankFusion([], []), []);
});

test("duplicates within one list count only once, at their first (best) rank", () => {
	const fused = reciprocalRankFusion(["a", "a", "b"], []);
	assert.equal(fused.length, 2);
	const a = fused.find((hit) => hit.id === "a");
	assert.ok(Math.abs(a.score - 1 / 61) < 1e-12);
});
