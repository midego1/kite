import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

const { SqliteVectorStore } = await bundleModules("kite-semantic-sqlite-store-", [
	["SqliteVectorStore", "server/runtime/sqlite-vector-store.ts"],
]);

const dir = mkdtempSync(join(tmpdir(), "kite-semantic-vectors-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function randomUnitVector(seed, dims = 1024) {
	// A small deterministic PRNG, so the fixture is reproducible without a crypto dependency.
	let state = seed;
	const next = () => {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		return state / 0x7fffffff;
	};
	const values = Float32Array.from({ length: dims }, () => next() * 2 - 1);
	const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
	return Float32Array.from(values, (value) => value / norm);
}

function cosine(a, b) {
	let dot = 0;
	for (let index = 0; index < a.length; index++) dot += a[index] * b[index];
	return dot;
}

test("int8 quantisation keeps the top-10 order of a float32 reference on fixtures", async (t) => {
	const store = new SqliteVectorStore(join(dir, "top10.sqlite"));
	t.after(() => store.close());
	const vectors = Array.from({ length: 50 }, (_, index) => ({
		id: `v${index}`,
		values: randomUnitVector(index + 1),
		mailboxId: "mailbox-a",
	}));
	await store.upsert(vectors);
	const query = randomUnitVector(999);
	const reference = vectors
		.map((item) => ({ id: item.id, score: cosine(query, item.values) }))
		.sort((a, b) => b.score - a.score)
		.slice(0, 10)
		.map((item) => item.id);
	const results = await store.query(query, { mailboxIds: ["mailbox-a"], topK: 10 });
	assert.deepEqual(
		results.map((item) => item.id),
		reference,
	);
});

test("scoping returns only vectors of the given mailboxes", async (t) => {
	const store = new SqliteVectorStore(join(dir, "scoping.sqlite"));
	t.after(() => store.close());
	await store.upsert([
		{ id: "a1", values: randomUnitVector(1), mailboxId: "mailbox-a" },
		{ id: "b1", values: randomUnitVector(2), mailboxId: "mailbox-b" },
	]);
	const query = randomUnitVector(1);
	const onlyA = await store.query(query, { mailboxIds: ["mailbox-a"], topK: 10 });
	assert.deepEqual(
		onlyA.map((item) => item.id),
		["a1"],
	);
	const both = await store.query(query, { mailboxIds: ["mailbox-a", "mailbox-b"], topK: 10 });
	assert.deepEqual(both.map((item) => item.id).sort(), ["a1", "b1"]);
	const neither = await store.query(query, { mailboxIds: ["mailbox-c"], topK: 10 });
	assert.deepEqual(neither, []);
});

test("delete removes a vector so it no longer matches any query", async (t) => {
	const store = new SqliteVectorStore(join(dir, "delete.sqlite"));
	t.after(() => store.close());
	const values = randomUnitVector(5);
	await store.upsert([{ id: "x1", values, mailboxId: "mailbox-a" }]);
	assert.deepEqual(
		(await store.query(values, { mailboxIds: ["mailbox-a"], topK: 5 })).map((item) => item.id),
		["x1"],
	);
	await store.deleteByIds(["x1"]);
	assert.deepEqual(await store.query(values, { mailboxIds: ["mailbox-a"], topK: 5 }), []);
});

test("upsert replaces an existing id's vector and mailbox instead of duplicating it", async (t) => {
	const store = new SqliteVectorStore(join(dir, "upsert.sqlite"));
	t.after(() => store.close());
	await store.upsert([{ id: "x1", values: randomUnitVector(1), mailboxId: "mailbox-a" }]);
	const updated = randomUnitVector(2);
	await store.upsert([{ id: "x1", values: updated, mailboxId: "mailbox-b" }]);
	assert.deepEqual(await store.query(updated, { mailboxIds: ["mailbox-a"], topK: 5 }), []);
	const results = await store.query(updated, { mailboxIds: ["mailbox-b"], topK: 5 });
	assert.equal(results.length, 1);
	assert.equal(results[0].id, "x1");
	assert.ok(results[0].score > 0.99);
});

test("listIds pages through every stored id", async (t) => {
	const store = new SqliteVectorStore(join(dir, "list.sqlite"));
	t.after(() => store.close());
	const items = Array.from({ length: 5 }, (_, index) => ({
		id: `v${index}`,
		values: randomUnitVector(index + 1),
		mailboxId: "mailbox-a",
	}));
	await store.upsert(items);
	const seen = [];
	let cursor = 0;
	for (;;) {
		const page = await store.listIds(cursor);
		seen.push(...page.ids);
		if (page.cursor === null) break;
		cursor = page.cursor;
	}
	assert.deepEqual(seen.sort(), items.map((item) => item.id).sort());
});
