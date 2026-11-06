import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

const { FileBucket } = await bundleModules("kite-file-bucket-list-", [["FileBucket", "server/runtime/file-bucket.ts"]]);

const root = mkdtempSync(join(tmpdir(), "kite-file-bucket-list-"));
after(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;

/** A bucket whose files are written straight to disk (no sidecars), which is all `list` needs. */
function bucketWith(keys) {
	const directory = join(root, `bucket-${++counter}`);
	mkdirSync(directory, { recursive: true });
	for (const key of keys) {
		mkdirSync(dirname(join(directory, key)), { recursive: true });
		writeFileSync(join(directory, key), key);
	}
	return { bucket: new FileBucket(directory), directory };
}

/** The R2 contract: the matching keys in lexical order, strictly after the cursor, at most `limit` per page. */
function expectedPage(allKeys, { prefix = "", cursor, startAfter, limit = 1000 }) {
	const start = [cursor, startAfter].reduce((latest, key) => (key && key > latest ? key : latest), "");
	const matching = allKeys.filter((key) => key.startsWith(prefix) && (!start || key > start)).sort();
	const size = Math.min(Math.max(limit, 1), 1000);
	const keys = matching.slice(0, size);
	const truncated = matching.length > size;
	return { keys, truncated, cursor: truncated ? keys.at(-1) : undefined };
}

async function pageOf(bucket, options) {
	const page = await bucket.list(options);
	return { keys: page.objects.map((object) => object.key), truncated: page.truncated, cursor: page.cursor };
}

async function walk(bucket, options) {
	const keys = [];
	let cursor;
	let pages = 0;
	do {
		const page = await bucket.list({ ...options, cursor });
		keys.push(...page.objects.map((object) => object.key));
		cursor = page.truncated ? page.cursor : undefined;
		pages++;
	} while (cursor);
	return { keys, pages };
}

const TRICKY = [
	"a-b",
	"a.txt",
	"a/b",
	"a/b.c",
	"a/c/d",
	"a/b0",
	"a/z",
	"a0",
	"ab/c",
	"B/upper",
	"b/lower",
	"inbound/2026-01/x",
	"inbound/2026-01/y",
	"inbound/2026-02/x",
	"inbound/2026/x",
	"inbound.old",
	"inbound/",
	"ünï/çödé",
	"z",
].filter((key) => !key.endsWith("/"));

test("list returns every key in lexical order, directories sorted by the keys under them", async () => {
	const { bucket } = bucketWith(TRICKY);
	const page = await pageOf(bucket, {});
	assert.deepEqual(page, expectedPage(TRICKY, {}));
	// After "B/upper", "a-b" and "a.txt" sort before the directory "a", "a0" after it.
	assert.deepEqual(page.keys.slice(1, 8), ["a-b", "a.txt", "a/b", "a/b.c", "a/b0", "a/c/d", "a/z"]);
	assert.equal(page.truncated, false);
	assert.equal(page.cursor, undefined);
});

test("list matches the R2 contract for prefixes that end inside a name or a directory", async () => {
	const { bucket } = bucketWith(TRICKY);
	for (const prefix of [
		"",
		"a",
		"a/",
		"a/b",
		"a/b/",
		"a-",
		"ab",
		"inbound",
		"inbound/",
		"inbound/2026",
		"inbound/2026-",
		"inbound/2026-01/",
		"ü",
		"nope",
		"z",
		"zz",
	]) {
		assert.deepEqual(
			await pageOf(bucket, { prefix }),
			expectedPage(TRICKY, { prefix }),
			`prefix ${JSON.stringify(prefix)}`,
		);
	}
});

test("list resumes strictly after the cursor and after startAfter, whether or not that key exists", async () => {
	const { bucket } = bucketWith(TRICKY);
	for (const key of [...TRICKY, "a/", "a/a", "a/b/", "a/c", "a/c/", "inbound/2026-01", "0", "~"]) {
		assert.deepEqual(await pageOf(bucket, { cursor: key }), expectedPage(TRICKY, { cursor: key }), `cursor ${key}`);
		assert.deepEqual(
			await pageOf(bucket, { startAfter: key }),
			expectedPage(TRICKY, { startAfter: key }),
			`startAfter ${key}`,
		);
		assert.deepEqual(
			await pageOf(bucket, { prefix: "a", cursor: "a-b", startAfter: key }),
			expectedPage(TRICKY, { prefix: "a", cursor: "a-b", startAfter: key }),
			`prefix with both ${key}`,
		);
	}
});

test("list pages by limit with a cursor, marks truncation and clamps the limit to 1-1000", async () => {
	const { bucket } = bucketWith(TRICKY);
	for (const limit of [1, 2, 3, 5, 7, 100]) {
		const { keys } = await walk(bucket, { limit });
		assert.deepEqual(keys, [...TRICKY].sort(), `limit ${limit}`);
	}
	const first = await pageOf(bucket, { limit: 3 });
	assert.deepEqual(first, expectedPage(TRICKY, { limit: 3 }));
	assert.equal(first.truncated, true);
	assert.equal(first.cursor, first.keys.at(-1));
	// An exactly full last page is not truncated.
	const exact = await pageOf(bucket, { limit: TRICKY.length });
	assert.equal(exact.truncated, false);
	assert.deepEqual(await pageOf(bucket, { limit: 0 }), expectedPage(TRICKY, { limit: 0 }));
	assert.deepEqual(await pageOf(bucket, { limit: -5 }), expectedPage(TRICKY, { limit: -5 }));
	assert.equal((await pageOf(bucket, { limit: 5000 })).keys.length, TRICKY.length);
});

test("list ignores sidecars, partial uploads and the multipart directory, and returns empty for nothing", async () => {
	const { bucket, directory } = bucketWith(["real/one", "real/two"]);
	writeFileSync(join(directory, "real/one.meta.json"), "{}");
	writeFileSync(join(directory, "real/three.abc.partial"), "x");
	mkdirSync(join(directory, ".multipart/upload-1"), { recursive: true });
	writeFileSync(join(directory, ".multipart/upload-1/part-1"), "x");
	assert.deepEqual((await pageOf(bucket, {})).keys, ["real/one", "real/two"]);
	assert.deepEqual(await pageOf(bucket, { prefix: ".multipart" }), { keys: [], truncated: false, cursor: undefined });
	assert.deepEqual(await pageOf(bucket, { prefix: "missing/" }), { keys: [], truncated: false, cursor: undefined });
	const empty = new FileBucket(join(root, "does-not-exist"));
	assert.deepEqual(await pageOf(empty, {}), { keys: [], truncated: false, cursor: undefined });
});

test("list returns the stored objects with their metadata", async () => {
	const files = new FileBucket(join(root, `bucket-${++counter}`));
	await files.put("inbound/a", "hello", { httpMetadata: { contentType: "text/plain" } });
	await files.put("inbound/b", "world!");
	const page = await files.list({ prefix: "inbound/" });
	assert.deepEqual(
		page.objects.map((object) => [object.key, object.size]),
		[
			["inbound/a", 5],
			["inbound/b", 6],
		],
	);
	assert.equal(page.objects[0].httpMetadata.contentType, "text/plain");
	assert.deepEqual(page.delimitedPrefixes, []);
});

test("list pages a large tree in order and matches a flat sort of the keys", async () => {
	// Deterministic pseudo-random layout: nested dates, shared name prefixes and keys next to directories.
	let seed = 42;
	const random = (max) => {
		seed = (seed * 1664525 + 1013904223) % 4294967296;
		return seed % max;
	};
	const keys = new Set();
	while (keys.size < 6000) {
		const kind = random(4);
		const day = `2026-${String(1 + random(12)).padStart(2, "0")}-${String(1 + random(28)).padStart(2, "0")}`;
		const id = random(1e9).toString(36);
		if (kind === 0) keys.add(`inbound/${day}/${id}`);
		else if (kind === 1) keys.add(`drive/${id.slice(0, 2)}/${id}`);
		else if (kind === 2) keys.add(`backups/${day}.${id}`);
		else keys.add(`inbound.${id}`);
	}
	const all = [...keys];
	const { bucket } = bucketWith(all);
	const sorted = [...all].sort();

	const full = await walk(bucket, {});
	assert.deepEqual(full.keys, sorted);
	assert.equal(full.pages, Math.ceil(all.length / 1000));

	const small = await walk(bucket, { limit: 77 });
	assert.deepEqual(small.keys, sorted);

	for (const prefix of [
		"inbound/",
		"inbound/2026-03",
		"inbound/2026-03-1",
		"inbound",
		"inbound.",
		"drive/a",
		"backups/2026-1",
	]) {
		const walked = await walk(bucket, { prefix, limit: 250 });
		assert.deepEqual(
			walked.keys,
			sorted.filter((key) => key.startsWith(prefix)),
			`prefix ${prefix}`,
		);
	}
	for (const cursor of [sorted[0], sorted[1234], sorted[4999], sorted.at(-1), "inbound/2026-06"]) {
		assert.deepEqual(await pageOf(bucket, { cursor, limit: 500 }), expectedPage(all, { cursor, limit: 500 }));
	}
});
