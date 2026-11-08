import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test, { after } from "node:test";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { migrationsDir, seedAccountData } from "./support/module-database.mjs";
import { bundleModules } from "./support/modules-bundle.mjs";

const {
	SqliteDatabase,
	applyMigrations,
	rebuildSemanticIndex,
	disableSemanticSearch,
	clearStaleVectors,
	clearMailboxSemanticIndex,
	requeueMailboxSemanticIndex,
} = await bundleModules("kite-semantic-admin-actions-", [
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
	[
		"rebuildSemanticIndex, disableSemanticSearch, clearStaleVectors, clearMailboxSemanticIndex, requeueMailboxSemanticIndex",
		"src/lib/semantic/admin-actions.ts",
	],
]);

const scratch = makeBundleDirectory("kite-semantic-admin-actions-dirs-");
after(() => rmSync(scratch, { recursive: true, force: true }));

async function database(t) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, migrationsDir);
	seedAccountData(db);
	db.db.exec(`
		INSERT INTO app_settings (id, semantic_search_enabled, updated_at) VALUES ('default', 1, 1)
		ON CONFLICT(id) DO UPDATE SET semantic_search_enabled = 1;
	`);
	return db;
}

function indexedRow(db, id, vectorKey, chunkCount, mailboxId = "mailbox-a") {
	db.db.exec(`
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at)
		VALUES ('${id}', 'owner', '${mailboxId}', 'inbound', 'x@example.net', 'a@example.com', 'Hi', 'Hello', 'received', 10);
	`);
	db.db
		.prepare("UPDATE message_embeddings SET status = 'indexed', vector_key = ?, chunk_count = ? WHERE message_id = ?")
		.run(vectorKey, chunkCount, id);
}

/**
 * Pages by a stable, ever-increasing rowid (like the real stores' `rowid > cursor` scans), not array position, so
 * deleting a page's orphans mid-scan cannot shift a later page's results the way an offset-based slice would.
 */
function fakeVectorStore() {
	const rows = new Map();
	let nextRowid = 1;
	return {
		store: {
			upsert: async (items) => {
				for (const item of items) if (!rows.has(item.id)) rows.set(item.id, nextRowid++);
			},
			deleteByIds: async (deleted) => {
				for (const id of deleted) rows.delete(id);
			},
			query: async () => [],
			listIds: async (cursor) => {
				const page = [...rows.entries()]
					.filter(([, rowid]) => rowid > cursor)
					.sort((a, b) => a[1] - b[1])
					.slice(0, 2);
				return { ids: page.map(([id]) => id), cursor: page.length < 2 ? null : page[page.length - 1][1] };
			},
		},
		seed: (seedIds) => seedIds.forEach((id) => rows.set(id, nextRowid++)),
		has: (id) => rows.has(id),
	};
}

test("rebuildSemanticIndex resets every row of an allowed mailbox to pending, but leaves a mailbox-off row skipped", async (t) => {
	const db = await database(t);
	indexedRow(db, "m1", "key1", 2, "mailbox-a");
	db.db.exec(
		"INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-b', 'owner', 'domain-1', 'b', 1)",
	);
	indexedRow(db, "m2", "key2", 1, "mailbox-b");
	db.db.exec(
		"INSERT INTO mailbox_agent_settings (mailbox_id, semantic_index, updated_at) VALUES ('mailbox-b', 0, 1) ON CONFLICT(mailbox_id) DO UPDATE SET semantic_index = 0",
	);
	db.db.exec("UPDATE message_embeddings SET status = 'skipped' WHERE message_id = 'm2'");
	const env = { DB: db };
	await rebuildSemanticIndex(env);
	assert.equal(db.db.prepare("SELECT status FROM message_embeddings WHERE message_id = 'm1'").get().status, "pending");
	assert.equal(db.db.prepare("SELECT status FROM message_embeddings WHERE message_id = 'm2'").get().status, "skipped");
});

test("disableSemanticSearch deletes every known vector, clears the state tables and the backfill cursor", async (t) => {
	const db = await database(t);
	indexedRow(db, "m1", "key1", 2);
	const fake = fakeVectorStore();
	fake.seed(["key1:0", "key1:1"]);
	db.db.exec('UPDATE app_settings SET semantic_backfill_cursor = \'{"createdAt":1,"id":"m0"}\' WHERE id = \'default\'');
	const env = { DB: db, VECTORS: fake.store };
	await disableSemanticSearch(env);
	assert.equal(fake.has("key1:0"), false);
	assert.equal(fake.has("key1:1"), false);
	assert.deepEqual(db.db.prepare("SELECT * FROM message_embeddings").all(), []);
	const row = db.db
		.prepare("SELECT semantic_search_enabled, semantic_backfill_cursor FROM app_settings WHERE id = 'default'")
		.get();
	assert.equal(row.semantic_search_enabled, 0);
	assert.equal(row.semantic_backfill_cursor, null);
});

test("clearStaleVectors removes vectors with no message_embeddings row, and leaves known ones alone", async (t) => {
	const db = await database(t);
	indexedRow(db, "m1", "key1", 1);
	const fake = fakeVectorStore();
	fake.seed(["key1:0", "orphan-key:0", "orphan-key:1"]);
	const env = { DB: db, VECTORS: fake.store };
	const result = await clearStaleVectors(env);
	assert.equal(result.supported, true);
	assert.equal(result.removed, 2);
	assert.equal(fake.has("key1:0"), true);
	assert.equal(fake.has("orphan-key:0"), false);
	assert.equal(fake.has("orphan-key:1"), false);
});

test("clearStaleVectors answers unsupported for a store with no listIds (Vectorize)", async (t) => {
	const db = await database(t);
	const env = { DB: db, VECTORS: { upsert: async () => {}, deleteByIds: async () => {}, query: async () => [] } };
	const result = await clearStaleVectors(env);
	assert.deepEqual(result, { supported: false, removed: 0 });
});

test("clearMailboxSemanticIndex marks the mailbox's rows skipped and deletes their vectors", async (t) => {
	const db = await database(t);
	indexedRow(db, "m1", "key1", 2);
	const fake = fakeVectorStore();
	fake.seed(["key1:0", "key1:1"]);
	await clearMailboxSemanticIndex({ DB: db, VECTORS: fake.store }, "mailbox-a");
	assert.equal(fake.has("key1:0"), false);
	const row = db.db.prepare("SELECT status, chunk_count FROM message_embeddings WHERE message_id = 'm1'").get();
	assert.equal(row.status, "skipped");
	assert.equal(row.chunk_count, 0);
});

test("requeueMailboxSemanticIndex sets a mailbox's rows back to pending, but only while its own switches allow it", async (t) => {
	const db = await database(t);
	indexedRow(db, "m1", "key1", 2);
	db.db.exec("UPDATE message_embeddings SET status = 'skipped' WHERE message_id = 'm1'");
	const env = { DB: db };
	await requeueMailboxSemanticIndex(env, "mailbox-a");
	assert.equal(db.db.prepare("SELECT status FROM message_embeddings WHERE message_id = 'm1'").get().status, "pending");

	// A mailbox whose own semantic_index switch is off is not requeued by this call.
	db.db.exec("UPDATE message_embeddings SET status = 'skipped' WHERE message_id = 'm1'");
	db.db.exec(
		"INSERT INTO mailbox_agent_settings (mailbox_id, semantic_index, updated_at) VALUES ('mailbox-a', 0, 1) ON CONFLICT(mailbox_id) DO UPDATE SET semantic_index = 0",
	);
	await requeueMailboxSemanticIndex(env, "mailbox-a");
	assert.equal(db.db.prepare("SELECT status FROM message_embeddings WHERE message_id = 'm1'").get().status, "skipped");
});
