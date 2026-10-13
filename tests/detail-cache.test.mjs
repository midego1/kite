import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-detail-cache-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/lib/messages/detail-cache-utils.ts")],
	outfile: join(outDir, "detail-cache-utils.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	alias: { "@": join(root, "src") },
});

const { MESSAGE_DETAIL_CACHE_LIMIT, readRecent, rememberRecent } = await import(
	pathToFileURL(join(outDir, "detail-cache-utils.mjs")).href
);

test("the message detail cache keeps a bounded number of bodies", () => {
	assert.ok(MESSAGE_DETAIL_CACHE_LIMIT > 0);
	const cache = new Map();
	for (let index = 0; index < MESSAGE_DETAIL_CACHE_LIMIT * 3; index += 1) {
		rememberRecent(cache, `m${index}`, { index }, MESSAGE_DETAIL_CACHE_LIMIT);
	}
	assert.equal(cache.size, MESSAGE_DETAIL_CACHE_LIMIT);
	assert.equal(cache.has("m0"), false);
	assert.equal(cache.has(`m${MESSAGE_DETAIL_CACHE_LIMIT * 3 - 1}`), true);
});

test("rememberRecent evicts the least recently used entry", () => {
	const cache = new Map();
	rememberRecent(cache, "a", 1, 2);
	rememberRecent(cache, "b", 2, 2);
	rememberRecent(cache, "c", 3, 2);
	assert.deepEqual([...cache.keys()], ["b", "c"]);
});

test("rememberRecent replaces an existing key without growing the cache", () => {
	const cache = new Map();
	rememberRecent(cache, "a", 1, 2);
	rememberRecent(cache, "b", 2, 2);
	rememberRecent(cache, "a", 10, 2);
	assert.deepEqual(
		[...cache.entries()],
		[
			["b", 2],
			["a", 10],
		],
	);
});

test("readRecent marks an entry as recently used so it survives eviction", () => {
	const cache = new Map();
	rememberRecent(cache, "a", 1, 2);
	rememberRecent(cache, "b", 2, 2);
	assert.equal(readRecent(cache, "a"), 1);
	rememberRecent(cache, "c", 3, 2);
	assert.deepEqual([...cache.keys()], ["a", "c"]);
});

test("readRecent leaves the cache alone on a miss", () => {
	const cache = new Map([["a", 1]]);
	assert.equal(readRecent(cache, "missing"), undefined);
	assert.deepEqual([...cache.keys()], ["a"]);
});

test("a limit of zero or less keeps nothing", () => {
	const cache = new Map();
	rememberRecent(cache, "a", 1, 0);
	assert.equal(cache.size, 0);
	rememberRecent(cache, "b", 2, -5);
	assert.equal(cache.size, 0);
});
