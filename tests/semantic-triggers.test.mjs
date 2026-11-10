import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test, { after } from "node:test";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { migrationsDir, seedAccountData } from "./support/module-database.mjs";
import { bundleModules } from "./support/modules-bundle.mjs";

const { SqliteDatabase, applyMigrations } = await bundleModules("kite-semantic-triggers-", [
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
]);

const scratch = makeBundleDirectory("kite-semantic-triggers-dirs-");
after(() => rmSync(scratch, { recursive: true, force: true }));

async function database(t) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, migrationsDir);
	seedAccountData(db);
	return db;
}

function enableSemanticSearch(db) {
	db.db.exec(`
		INSERT INTO app_settings (id, semantic_search_enabled, updated_at) VALUES ('default', 1, 1)
		ON CONFLICT(id) DO UPDATE SET semantic_search_enabled = 1;
	`);
}

function insertMessage(db, id, overrides = {}) {
	const fields = {
		mailbox_id: "mailbox-a",
		status: "received",
		spam_verdict: null,
		created_at: 10,
		...overrides,
	};
	db.db
		.prepare(
			`INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, spam_verdict, created_at)
			VALUES (?, 'owner', ?, 'inbound', 'x@example.net', 'a@example.com', 'Hi', 'body', ?, ?, ?)`,
		)
		.run(id, fields.mailbox_id, fields.status, fields.spam_verdict, fields.created_at);
}

const stateRows = (db) =>
	db.db.prepare("SELECT message_id, mailbox_id, status FROM message_embeddings ORDER BY message_id").all();
const tombstones = (db) => db.db.prepare("SELECT vector_key, chunk_count FROM message_embedding_deletes").all();

test("the triggers do nothing while the feature is off", async (t) => {
	const db = await database(t);
	insertMessage(db, "m1");
	assert.deepEqual(stateRows(db), []);
});

test("an eligible message queues a pending row once the feature is on; spam and non-eligible statuses do not", async (t) => {
	const db = await database(t);
	enableSemanticSearch(db);
	insertMessage(db, "m1");
	insertMessage(db, "m2", { spam_verdict: "spam" });
	insertMessage(db, "m3", { status: "draft" });
	assert.deepEqual(stateRows(db), [{ message_id: "m1", mailbox_id: "mailbox-a", status: "pending" }]);
});

test("a status change into an eligible status queues a pending row; a change between two eligible statuses does not", async (t) => {
	const db = await database(t);
	enableSemanticSearch(db);
	insertMessage(db, "draft-becomes-received", { status: "draft" });
	db.db.exec("UPDATE messages SET status = 'received' WHERE id = 'draft-becomes-received'");
	assert.deepEqual(stateRows(db), [
		{ message_id: "draft-becomes-received", mailbox_id: "mailbox-a", status: "pending" },
	]);

	// received -> archived: both eligible, so the trigger leaves the indexed row alone instead of re-queueing it.
	db.db.exec("UPDATE message_embeddings SET status = 'indexed' WHERE message_id = 'draft-becomes-received'");
	db.db.exec("UPDATE messages SET status = 'archived' WHERE id = 'draft-becomes-received'");
	assert.deepEqual(stateRows(db), [
		{ message_id: "draft-becomes-received", mailbox_id: "mailbox-a", status: "indexed" },
	]);
});

test("a skipped row returns to pending when its message becomes eligible again; an indexed row is untouched", async (t) => {
	const db = await database(t);
	enableSemanticSearch(db);
	insertMessage(db, "m1");
	db.db.exec("UPDATE message_embeddings SET status = 'skipped' WHERE message_id = 'm1'");
	db.db.exec("UPDATE messages SET status = 'trash' WHERE id = 'm1'");
	db.db.exec("UPDATE messages SET status = 'received' WHERE id = 'm1'");
	assert.deepEqual(stateRows(db), [{ message_id: "m1", mailbox_id: "mailbox-a", status: "pending" }]);
});

test("a mailbox with 'No AI for this mailbox' on never gets a row, even while the feature is on", async (t) => {
	const db = await database(t);
	enableSemanticSearch(db);
	db.db.exec(
		"INSERT INTO mailbox_agent_settings (mailbox_id, ai_disabled, updated_at) VALUES ('mailbox-a', 1, 1) ON CONFLICT(mailbox_id) DO UPDATE SET ai_disabled = 1",
	);
	insertMessage(db, "m1");
	db.db.exec("UPDATE messages SET status = 'draft' WHERE id = 'm1'");
	db.db.exec("UPDATE messages SET status = 'received' WHERE id = 'm1'");
	assert.deepEqual(stateRows(db), []);
});

test("a mailbox with the per-mailbox semantic_index switch off still gets rows from the trigger (checked at drain time instead)", async (t) => {
	const db = await database(t);
	enableSemanticSearch(db);
	db.db.exec(
		"INSERT INTO mailbox_agent_settings (mailbox_id, semantic_index, updated_at) VALUES ('mailbox-a', 0, 1) ON CONFLICT(mailbox_id) DO UPDATE SET semantic_index = 0",
	);
	insertMessage(db, "m1");
	assert.deepEqual(stateRows(db), [{ message_id: "m1", mailbox_id: "mailbox-a", status: "pending" }]);
});

test("deleting a message removes its state row and leaves a tombstone, whether or not it was ever indexed", async (t) => {
	const db = await database(t);
	enableSemanticSearch(db);
	insertMessage(db, "never-indexed");
	insertMessage(db, "was-indexed");
	db.db.exec(
		"UPDATE message_embeddings SET status = 'indexed', vector_key = 'abc123', chunk_count = 2 WHERE message_id = 'was-indexed'",
	);
	db.db.exec("DELETE FROM messages WHERE id IN ('never-indexed', 'was-indexed')");
	assert.deepEqual(stateRows(db), []);
	assert.deepEqual(
		tombstones(db).sort((a, b) => (a.vector_key ?? "").localeCompare(b.vector_key ?? "")),
		[
			{ vector_key: null, chunk_count: 0 },
			{ vector_key: "abc123", chunk_count: 2 },
		],
	);
});

test("turning the feature off clears every state row, tombstone and the backfill cursor", async (t) => {
	const db = await database(t);
	enableSemanticSearch(db);
	insertMessage(db, "m1");
	insertMessage(db, "m2");
	db.db.exec(
		"UPDATE message_embeddings SET status = 'indexed', vector_key = 'abc', chunk_count = 1 WHERE message_id = 'm1'",
	);
	db.db.exec("DELETE FROM messages WHERE id = 'm2'");
	assert.ok(stateRows(db).length > 0);
	assert.ok(tombstones(db).length > 0);

	db.db.exec(
		"UPDATE app_settings SET semantic_search_enabled = 0, semantic_backfill_cursor = NULL WHERE id = 'default'; DELETE FROM message_embeddings; DELETE FROM message_embedding_deletes;",
	);
	assert.deepEqual(stateRows(db), []);
	assert.deepEqual(tombstones(db), []);

	// Turning it on again starts a complete backfill: a new message is queued as if for the first time.
	db.db.exec("UPDATE app_settings SET semantic_search_enabled = 1 WHERE id = 'default'");
	insertMessage(db, "m3");
	assert.deepEqual(stateRows(db), [{ message_id: "m3", mailbox_id: "mailbox-a", status: "pending" }]);
});
