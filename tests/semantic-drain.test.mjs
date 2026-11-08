import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test, { after } from "node:test";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { D1_BOUND_PARAMETER_LIMIT, limitBoundParameters } from "./support/jmap-database.mjs";
import { copyMigrationsBefore, migrationsDir, seedAccountData } from "./support/module-database.mjs";
import { bundleModules } from "./support/modules-bundle.mjs";

// import.meta.resolve (plain strings in bundleModules's export list are invisible to it) lets knip see this test
// uses indexer.ts, so its exports below are not reported as dead code.
void import.meta.resolve("../src/lib/semantic/indexer.ts");

const { SqliteDatabase, applyMigrations, processEmbeddingBatch, drainDeleteTombstones } = await bundleModules(
	"kite-semantic-drain-",
	[
		["SqliteDatabase", "server/runtime/sqlite-database.ts"],
		["applyMigrations", "server/runtime/migrate.ts"],
		["processEmbeddingBatch, drainDeleteTombstones", "src/lib/semantic/indexer.ts"],
	],
);

const scratch = makeBundleDirectory("kite-semantic-drain-dirs-");
after(() => rmSync(scratch, { recursive: true, force: true }));

function fakeVectors(count) {
	return Array.from({ length: count }, () => Array.from({ length: 1024 }, () => 0.01));
}

async function setup(t) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, migrationsDir);
	seedAccountData(db);
	db.db.exec(`
		INSERT INTO app_settings (id, semantic_search_enabled, updated_at) VALUES ('default', 1, 1)
		ON CONFLICT(id) DO UPDATE SET semantic_search_enabled = 1;
	`);
	const upserts = [];
	const deletedIds = [];
	const vectors = {
		upsert: async (items) => upserts.push(...items),
		deleteByIds: async (ids) => deletedIds.push(...ids),
		query: async () => [],
	};
	const env = { DB: db, VECTORS: vectors, AI: null };
	return { db, env, upserts, deletedIds };
}

test("a message deleted while its embedding call is in flight gets no vectors, and its tombstone drains with nothing to delete", async (t) => {
	const { db, env, upserts, deletedIds } = await setup(t);
	db.db.exec(`
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at)
		VALUES ('race-message', 'owner', 'mailbox-a', 'inbound', 'x@example.net', 'a@example.com', 'Hi', 'Hello there', 'received', 10);
	`);
	let ranDuringCall = false;
	env.AI = {
		run: async (_model, input) => {
			// The message is deleted while this call is still in flight: the trigger removes its state row and
			// leaves a tombstone with no vector key, since the row never got one written back.
			db.db.exec("DELETE FROM messages WHERE id = 'race-message'");
			ranDuringCall = true;
			return { data: fakeVectors(input.text.length) };
		},
	};
	const result = await processEmbeddingBatch(env);
	assert.ok(ranDuringCall);
	assert.equal(result.claimed, 1);
	// Nothing was written to the vector store for the deleted message.
	assert.deepEqual(upserts, []);
	// Its tombstone had no vector key to remove, so nothing was deleted either.
	assert.deepEqual(deletedIds, []);
	assert.deepEqual(db.db.prepare("SELECT * FROM message_embeddings").all(), []);
	// The same call's own tombstone drain already processed it: nothing to remove, so nothing was left behind either.
	assert.deepEqual(db.db.prepare("SELECT vector_key, chunk_count FROM message_embedding_deletes").all(), []);
});

test("a mailbox cleared while a message's embedding call is still in flight gets its freshly-written vectors deleted again, never indexed (S1 of review round 2)", async (t) => {
	const { db, env, upserts, deletedIds } = await setup(t);
	db.db.exec(`
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at)
		VALUES ('race-message', 'owner', 'mailbox-a', 'inbound', 'x@example.net', 'a@example.com', 'Hi', 'Hello there', 'received', 10);
	`);
	env.AI = { run: async (_model, input) => ({ data: fakeVectors(input.text.length) }) };
	// `clearMailboxSemanticIndex` (or the mailbox going No AI) marking this row `skipped` lands in the narrow window
	// between the `rowsStillRunning` check (which still read `running`) and the final guarded write: simulated here
	// by running it from inside the fake store's own `upsert`, the one awaited call between the two.
	env.VECTORS.upsert = async (items) => {
		db.db.exec(
			"UPDATE message_embeddings SET status = 'skipped', lease_until = NULL WHERE message_id = 'race-message'",
		);
		upserts.push(...items);
	};
	const result = await processEmbeddingBatch(env);
	assert.equal(result.claimed, 1);
	const row = db.db
		.prepare("SELECT status, vector_key, chunk_count FROM message_embeddings WHERE message_id = 'race-message'")
		.get();
	// Never flipped back to indexed: the guarded update matched nothing because status was no longer 'running'.
	assert.equal(row.status, "skipped");
	assert.equal(row.vector_key, null);
	assert.equal(row.chunk_count, 0);
	// The vectors `upsert` just wrote are deleted again, not left orphaned in the store.
	assert.ok(upserts.length > 0);
	assert.deepEqual(deletedIds.sort(), upserts.map((item) => item.id).sort());
});

test("an ordinary message is embedded, upserted and marked indexed", async (t) => {
	const { db, env, upserts } = await setup(t);
	db.db.exec(`
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at)
		VALUES ('m1', 'owner', 'mailbox-a', 'inbound', 'x@example.net', 'a@example.com', 'Hi', 'Hello there', 'received', 10);
	`);
	env.AI = { run: async (_model, input) => ({ data: fakeVectors(input.text.length) }) };
	const result = await processEmbeddingBatch(env);
	assert.equal(result.claimed, 1);
	assert.equal(upserts.length, 1);
	const row = db.db
		.prepare("SELECT status, chunk_count, vector_key FROM message_embeddings WHERE message_id = 'm1'")
		.get();
	assert.equal(row.status, "indexed");
	assert.equal(row.chunk_count, 1);
	assert.match(row.vector_key, /^[0-9a-f]{32}$/);
});

test("when a re-embedded message needs fewer chunks than before, the extra old ones are deleted from the store", async (t) => {
	const { db, env, deletedIds } = await setup(t);
	db.db.exec(`
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at)
		VALUES ('m1', 'owner', 'mailbox-a', 'inbound', 'x@example.net', 'a@example.com', 'Hi', 'Hello there', 'received', 10);
	`);
	// Simulate an earlier index with 3 chunks under a stale content hash, so this run must re-embed and shrink it.
	db.db
		.prepare(
			"UPDATE message_embeddings SET status = 'indexed', vector_key = 'abc123', chunk_count = 3, content_hash = 'stale' WHERE message_id = 'm1'",
		)
		.run();
	db.db.exec("UPDATE message_embeddings SET status = 'pending', queued_at = 11 WHERE message_id = 'm1'");
	env.AI = { run: async (_model, input) => ({ data: fakeVectors(input.text.length) }) };
	const result = await processEmbeddingBatch(env);
	assert.equal(result.claimed, 1);
	assert.deepEqual(deletedIds, ["abc123:1", "abc123:2"]);
	const row = db.db.prepare("SELECT chunk_count, vector_key FROM message_embeddings WHERE message_id = 'm1'").get();
	assert.equal(row.chunk_count, 1);
	assert.equal(row.vector_key, "abc123");
});

test("a provider error retries up to 3 attempts, then fails with an error code and no content", async (t) => {
	const { db, env } = await setup(t);
	db.db.exec(`
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at)
		VALUES ('m1', 'owner', 'mailbox-a', 'inbound', 'x@example.net', 'a@example.com', 'Hi', 'Hello there', 'received', 10);
	`);
	env.AI = {
		run: async () => {
			throw new Error("upstream boom with secret content");
		},
	};
	for (let attempt = 1; attempt <= 3; attempt++) {
		await processEmbeddingBatch(env);
		const row = db.db.prepare("SELECT status, attempts, error FROM message_embeddings WHERE message_id = 'm1'").get();
		if (attempt < 3) {
			assert.equal(row.status, "pending");
			assert.equal(row.attempts, attempt);
		} else {
			assert.equal(row.status, "failed");
			assert.equal(row.attempts, 3);
			assert.ok(row.error);
			assert.doesNotMatch(row.error, /secret content/);
		}
	}
});

test("drainDeleteTombstones removes the vectors of a deleted, previously-indexed message and clears the tombstone", async (t) => {
	const { db, env, deletedIds } = await setup(t);
	db.db.exec(`
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at)
		VALUES ('m1', 'owner', 'mailbox-a', 'inbound', 'x@example.net', 'a@example.com', 'Hi', 'Hello there', 'received', 10);
	`);
	db.db.exec(
		"UPDATE message_embeddings SET status = 'indexed', vector_key = 'abc123', chunk_count = 2 WHERE message_id = 'm1'",
	);
	db.db.exec("DELETE FROM messages WHERE id = 'm1'");
	assert.equal(db.db.prepare("SELECT count(*) AS n FROM message_embedding_deletes").get().n, 1);
	await drainDeleteTombstones(env);
	assert.deepEqual(deletedIds.sort(), ["abc123:0", "abc123:1"]);
	assert.equal(db.db.prepare("SELECT count(*) AS n FROM message_embedding_deletes").get().n, 0);
});

test("processEmbeddingBatch still drains tombstones while the embedding gate is closed (the kill switch off)", async (t) => {
	const { db, env, deletedIds } = await setup(t);
	db.db.exec(`
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at)
		VALUES ('m1', 'owner', 'mailbox-a', 'inbound', 'x@example.net', 'a@example.com', 'Hi', 'Hello there', 'received', 10);
	`);
	db.db.exec(
		"UPDATE message_embeddings SET status = 'indexed', vector_key = 'abc123', chunk_count = 2 WHERE message_id = 'm1'",
	);
	db.db.exec("DELETE FROM messages WHERE id = 'm1'");
	assert.equal(db.db.prepare("SELECT count(*) AS n FROM message_embedding_deletes").get().n, 1);
	// Closing the gate (the install kill switch) must not leave this mailbox's vectors searchable forever.
	db.db.exec("UPDATE app_settings SET agent_enabled = 0 WHERE id = 'default'");
	const { claimed } = await processEmbeddingBatch(env);
	assert.equal(claimed, 0);
	assert.deepEqual(deletedIds.sort(), ["abc123:0", "abc123:1"]);
	assert.equal(db.db.prepare("SELECT count(*) AS n FROM message_embedding_deletes").get().n, 0);
});

test("drainDeleteTombstones clears a page of more than 100 tombstones without exceeding D1's bound-parameter limit (R3 of review round 2)", async (t) => {
	const { db, env, deletedIds } = await setup(t);
	const count = 150; // more than the 100-parameter limit a per-row DELETE ... IN (...) used to bind.
	const rows = Array.from(
		{ length: count },
		(_, index) =>
			`('m${index}', 'owner', 'mailbox-a', 'inbound', 'x@example.net', 'a@example.com', 'Hi', 'Hello there', 'received', ${index})`,
	).join(",\n");
	db.db.exec(
		`INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at) VALUES ${rows};`,
	);
	for (let index = 0; index < count; index++)
		db.db
			.prepare("UPDATE message_embeddings SET status = 'indexed', vector_key = ?, chunk_count = 1 WHERE message_id = ?")
			.run(`key${index}`, `m${index}`);
	db.db.exec(
		`DELETE FROM messages WHERE id IN (${Array.from({ length: count }, (_, index) => `'m${index}'`).join(",")})`,
	);
	assert.equal(db.db.prepare("SELECT count(*) AS n FROM message_embedding_deletes").get().n, count);

	const stats = limitBoundParameters(db);
	await drainDeleteTombstones(env);
	assert.ok(stats.maxBound <= D1_BOUND_PARAMETER_LIMIT, `bound ${stats.maxBound}`);
	assert.equal(deletedIds.length, count);
	assert.equal(db.db.prepare("SELECT count(*) AS n FROM message_embedding_deletes").get().n, 0);
});

test("drainDeleteTombstones is quiet, not throwing, before migration 0099 (S5 of review round 2)", async (t) => {
	const before = copyMigrationsBefore(scratch, 99);
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, before);
	// worker.ts and scheduler.ts call this directly from cron, every tick, on every install (off by default): it
	// must not throw "no such table: message_embedding_deletes" there, which would log as an error forever.
	await drainDeleteTombstones({ DB: db });
});
