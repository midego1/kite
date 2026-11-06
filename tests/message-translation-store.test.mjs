import assert from "node:assert/strict";
import test from "node:test";
import { migrationsDir, seedAccountData } from "./support/module-database.mjs";
import { bundleModules } from "./support/modules-bundle.mjs";

const {
	SqliteDatabase,
	applyMigrations,
	assertBackupTablesCoverDatabase,
	exportDatabaseRecords,
	createDb,
	readMessageTranslation,
	saveMessageTranslation,
	readCachedSummary,
} = await bundleModules("kite-message-translation-store-", [
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
	["assertBackupTablesCoverDatabase, exportDatabaseRecords", "src/lib/backups/export.ts"],
	["createDb", "src/db/index.ts"],
	["readMessageTranslation, saveMessageTranslation", "src/lib/agent/translation/store.ts"],
	["readCachedSummary", "src/lib/agent/summaries/store.ts"],
]);

async function database(t) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, migrationsDir);
	seedAccountData(db);
	return db;
}

const content = { from: "th", subject: "Hello", segments: ["One", null, "Three"] };
const input = {
	mailboxId: "mailbox-a",
	threadKey: "thread-1",
	messageId: "message-1",
	language: "en",
	content,
	digest: "digest-1",
	modelId: "fake-model",
	userId: "owner",
};
const count = (db) =>
	db.db.prepare("SELECT count(*) AS n FROM ai_summaries WHERE kind = 'message_translation'").get().n;

test("a translation is saved per language and read back as it was", async (t) => {
	const db = await database(t);
	assert.equal(await saveMessageTranslation(db, input), true);
	assert.equal(await saveMessageTranslation(db, { ...input, language: "nl", digest: "digest-nl" }), true);
	const { pending, row } = await readMessageTranslation(createDb(db), "message-1", "en");
	assert.equal(pending, false);
	assert.deepEqual(row, { content, digest: "digest-1", model: "fake-model" });
	assert.equal((await readMessageTranslation(createDb(db), "message-1", "nl")).row.digest, "digest-nl");
	assert.equal((await readMessageTranslation(createDb(db), "message-1", "de")).row, null);
	const [stored] = db.db.prepare("SELECT * FROM ai_summaries WHERE language = 'en'").all();
	assert.equal(stored.covered_count, 2);
	assert.equal(stored.created_by_user_id, "owner");
	assert.equal(stored.translation_of, null);
});

test("saving again replaces the row, so quoted text can join it", async (t) => {
	const db = await database(t);
	await saveMessageTranslation(db, input);
	const more = { ...content, segments: ["One", "Two", "Three"] };
	assert.equal(await saveMessageTranslation(db, { ...input, content: more }), true);
	assert.equal(count(db), 1);
	assert.deepEqual((await readMessageTranslation(createDb(db), "message-1", "en")).row.content, more);
});

test("a translation goes with its message", async (t) => {
	const db = await database(t);
	await saveMessageTranslation(db, input);
	db.db.prepare("DELETE FROM messages WHERE id = 'message-1'").run();
	assert.equal(count(db), 0);
});

test("moving the message to Trash or Spam deletes the translation, and one cannot be saved there", async (t) => {
	const db = await database(t);
	await saveMessageTranslation(db, input);
	db.db.prepare("UPDATE messages SET status = 'trash' WHERE id = 'message-1'").run();
	assert.equal(count(db), 0);
	assert.equal(await saveMessageTranslation(db, input), false, "the model answered after the move");
	assert.equal(count(db), 0);
	db.db.prepare("UPDATE messages SET status = 'received', spam_verdict = 'spam' WHERE id = 'message-1'").run();
	assert.equal(await saveMessageTranslation(db, input), false);
	db.db.prepare("UPDATE messages SET spam_verdict = NULL WHERE id = 'message-1'").run();
	assert.equal(await saveMessageTranslation(db, { ...input, mailboxId: "mailbox-b" }), false, "another mailbox");
	assert.equal(await saveMessageTranslation(db, { ...input, messageId: "gone" }), false);
});

test("a row that cannot be read counts as none", async (t) => {
	const db = await database(t);
	await saveMessageTranslation(db, input);
	db.db.prepare("UPDATE ai_summaries SET text = 'not json' WHERE kind = 'message_translation'").run();
	assert.equal((await readMessageTranslation(createDb(db), "message-1", "en")).row, null);
	db.db.prepare(`UPDATE ai_summaries SET text = '{"from":"th"}' WHERE kind = 'message_translation'`).run();
	assert.equal((await readMessageTranslation(createDb(db), "message-1", "en")).row, null);
});

test("translations are not summaries of the message, and not in backups", async (t) => {
	const db = await database(t);
	await saveMessageTranslation(db, input);
	const key = { mailboxId: "mailbox-a", kind: "message", threadKey: "thread-1", messageId: "message-1", digest: "" };
	assert.equal((await readCachedSummary(createDb(db), key, "en")).source, null);
	await assertBackupTablesCoverDatabase(db);
	const backup = await exportDatabaseRecords(db);
	assert.equal(JSON.stringify(backup).includes("message_translation"), false);
});

test("before migration 0072 a read says so", async (t) => {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	assert.deepEqual(await readMessageTranslation(createDb(db), "message-1", "en"), { pending: true, row: null });
});
