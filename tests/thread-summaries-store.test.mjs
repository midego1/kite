import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test, { after } from "node:test";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { copyMigrationsBefore, migrationsDir, seedAccountData } from "./support/module-database.mjs";
import { bundleModules } from "./support/modules-bundle.mjs";

const {
	SqliteDatabase,
	applyMigrations,
	assertBackupTablesCoverDatabase,
	exportDatabaseRecords,
	restoreDatabaseRecords,
	createDb,
	readCachedSummary,
	saveSummary,
	saveTranslation,
	runDatabasePruning,
} = await bundleModules("kite-thread-summaries-store-", [
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
	["assertBackupTablesCoverDatabase, exportDatabaseRecords, restoreDatabaseRecords", "src/lib/backups/export.ts"],
	["createDb", "src/db/index.ts"],
	["readCachedSummary, saveSummary, saveTranslation", "src/lib/agent/summaries/store.ts"],
	["runDatabasePruning", "src/lib/maintenance/pruning.ts"],
]);

const scratch = makeBundleDirectory("kite-thread-summaries-store-dirs-");
after(() => rmSync(scratch, { recursive: true, force: true }));

async function database(t, dir = migrationsDir) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, dir);
	seedAccountData(db);
	// A second message in thread-1, a message of another conversation, and a draft in thread-1.
	db.db.exec(`
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, thread_id, created_at) VALUES
			('message-2', 'owner', 'mailbox-a', 'outbound', 'a@example.com', 'customer@example.net', 'Re: Question', 'Answer', 'sent', 'thread-1', 4),
			('other-1', 'owner', 'mailbox-a', 'inbound', 'x@example.net', 'a@example.com', 'Other', 'Other', 'received', NULL, 5),
			('draft-1', 'owner', 'mailbox-a', 'outbound', 'a@example.com', 'customer@example.net', 'Re: Question', 'Draft', 'draft', 'thread-1', 6);
	`);
	return db;
}

const all = (db, query) => db.db.prepare(query).all();
const content = (overview, language = "en") => ({ language, overview, points: [{ label: "Dates", text: "Tuesday." }] });
const threadKey = (digest = "") => ({
	mailboxId: "mailbox-a",
	kind: "thread",
	threadKey: "thread-1",
	messageId: null,
	digest,
});

async function saveThread(db, overview = "Thread summary.", options = {}) {
	return saveSummary(db, {
		key: threadKey(options.digest),
		coveredIds: options.ids ?? ["message-1", "message-2"],
		coverageDigest: options.coverage ?? "cov-1",
		summary: content(overview, options.language),
		modelId: "fake-triage",
		userId: "owner",
	});
}

async function seedSummaries(db) {
	assert.equal(await saveThread(db), true);
	const [source] = all(db, "SELECT id FROM ai_summaries WHERE kind = 'thread'");
	assert.equal(
		await saveTranslation(db, {
			sourceId: source.id,
			translation: content("Vertaald.", "nl"),
			modelId: "m",
			userId: "member",
		}),
		true,
	);
	assert.equal(
		await saveSummary(db, {
			key: { mailboxId: "mailbox-a", kind: "message", threadKey: "thread-1", messageId: "message-1", digest: "" },
			coveredIds: ["message-1"],
			coverageDigest: "cov-m1",
			summary: content("Message summary."),
			modelId: null,
			userId: null,
		}),
		true,
	);
	assert.equal(
		await saveSummary(db, {
			key: { mailboxId: "mailbox-a", kind: "thread", threadKey: "other-1", messageId: null, digest: "" },
			coveredIds: ["other-1"],
			coverageDigest: "cov-o",
			summary: content("Other summary."),
			modelId: null,
			userId: null,
		}),
		true,
	);
}

const rows = (db) =>
	all(
		db,
		"SELECT kind, thread_key, message_id, language, translation_of IS NOT NULL AS translated FROM ai_summaries ORDER BY kind, thread_key, language",
	);

test("a saved summary is read back with its translation, and saving again replaces both", async (t) => {
	const db = await database(t);
	await seedSummaries(db);
	const appDb = createDb(db);
	const cached = await readCachedSummary(appDb, threadKey(), "nl");
	assert.equal(cached.pending, false);
	assert.equal(cached.source.coverageDigest, "cov-1");
	assert.equal(cached.source.coveredCount, 2);
	assert.equal(cached.source.createdByUserId, "owner");
	assert.deepEqual(JSON.parse(cached.source.text), {
		overview: "Thread summary.",
		points: [{ label: "Dates", text: "Tuesday." }],
	});
	assert.equal(cached.translation.language, "nl");
	assert.equal(cached.translation.translationOf, cached.source.id);
	assert.equal((await readCachedSummary(appDb, threadKey(), "de")).translation, null);
	assert.equal((await readCachedSummary(appDb, threadKey("personal"), null)).source, null);

	// Summarize again, now in another language: the old row and its translation are gone.
	assert.equal(await saveThread(db, "New summary.", { coverage: "cov-2", language: "nl" }), true);
	const again = await readCachedSummary(appDb, threadKey(), "nl");
	assert.equal(again.source.coverageDigest, "cov-2");
	assert.equal(again.translation, null);
	assert.equal(
		all(db, "SELECT count(*) AS n FROM ai_summaries WHERE thread_key = 'thread-1' AND kind = 'thread'")[0].n,
		1,
	);

	// Personal instructions get their own row next to the shared one.
	assert.equal(await saveThread(db, "Personal.", { digest: "abc" }), true);
	assert.equal(
		all(db, "SELECT count(*) AS n FROM ai_summaries WHERE kind = 'thread' AND thread_key = 'thread-1'")[0].n,
		2,
	);
});

test("a summary is not saved when a covered message was deleted, trashed or is not eligible", async (t) => {
	const db = await database(t);
	db.db.exec("UPDATE messages SET status = 'trash' WHERE id = 'message-2'");
	assert.equal(await saveThread(db), false);
	db.db.exec("UPDATE messages SET status = 'sent' WHERE id = 'message-2'");
	db.db.exec("DELETE FROM messages WHERE id = 'message-2'");
	assert.equal(await saveThread(db), false);
	assert.equal(await saveThread(db, "With a draft.", { ids: ["message-1", "draft-1"] }), false);
	db.db.exec("UPDATE messages SET spam_verdict = 'spam' WHERE id = 'message-1'");
	assert.equal(await saveThread(db, "Spam.", { ids: ["message-1"] }), false);
	assert.deepEqual(all(db, "SELECT count(*) AS n FROM ai_summaries"), [{ n: 0 }]);
	// A translation needs its source row.
	assert.equal(
		await saveTranslation(db, { sourceId: "missing", translation: content("X", "nl"), modelId: null, userId: null }),
		false,
	);
});

test("moving a message to Spam or Trash removes its conversation's summaries and its own", async (t) => {
	for (const status of ["trash", "spam"]) {
		const db = await database(t);
		await seedSummaries(db);
		db.db.exec(`UPDATE messages SET status = '${status}' WHERE id = 'message-1'`);
		assert.deepEqual(
			rows(db),
			[{ kind: "thread", thread_key: "other-1", message_id: null, language: "en", translated: 0 }],
			status,
		);
	}
});

test("deleting a message removes its conversation's summaries; reads, stars and other moves keep them", async (t) => {
	const db = await database(t);
	await seedSummaries(db);
	db.db.exec("UPDATE messages SET read = 1, starred = 1 WHERE id = 'message-1'");
	db.db.exec("UPDATE messages SET status = 'archived' WHERE id = 'message-1'");
	db.db.exec("UPDATE messages SET status = 'received' WHERE id = 'message-1'");
	db.db.exec("UPDATE messages SET status = 'trash' WHERE id = 'draft-1'");
	assert.equal(rows(db).length, 4);
	db.db.exec("DELETE FROM messages WHERE id = 'message-2'");
	assert.deepEqual(
		rows(db).map((row) => `${row.kind}:${row.thread_key}`),
		["message:thread-1", "thread:other-1"],
	);
	db.db.exec("DELETE FROM messages WHERE id = 'message-1'");
	assert.deepEqual(
		rows(db).map((row) => `${row.kind}:${row.thread_key}`),
		["thread:other-1"],
	);
});

test("pruning removes conversation summaries out of date for 30 days and keeps the rest", async (t) => {
	const db = await database(t);
	await seedSummaries(db);
	const day = 86_400;
	const now = new Date(100 * day * 1000);
	// thread-1's summary was made on day 10 and a message arrived on day 20: out of date for 80 days.
	// other-1's summary is just as old but nothing arrived since.
	db.db.exec(`UPDATE ai_summaries SET updated_at = ${10 * day}`);
	db.db
		.exec(`INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, thread_id, created_at)
		VALUES ('message-3', 'owner', 'mailbox-a', 'inbound', 'customer@example.net', 'a@example.com', 'Re', 'More', 'received', 'thread-1', ${20 * day})`);
	const result = await runDatabasePruning({ DB: db }, now);
	// The stale summary itself; its translation goes with it through the cascade.
	assert.equal(result.ai_summaries, 1);
	assert.deepEqual(
		rows(db).map((row) => `${row.kind}:${row.thread_key}`),
		["message:thread-1", "thread:other-1"],
	);
});

test("backups skip ai_summaries, and a restore leaves it empty", async (t) => {
	const db = await database(t);
	await seedSummaries(db);
	await assertBackupTablesCoverDatabase(db);
	const document = JSON.parse(new TextDecoder().decode(await exportDatabaseRecords(db)));
	assert.equal("ai_summaries" in document.tables, false);
	assert.equal(document.includedTables?.includes("ai_summaries") ?? false, false);

	const target = await database(t);
	await seedSummaries(target);
	await restoreDatabaseRecords(target, new TextEncoder().encode(JSON.stringify(document)).buffer);
	assert.deepEqual(all(target, "SELECT count(*) AS n FROM ai_summaries"), [{ n: 0 }]);
	await assertBackupTablesCoverDatabase(target);
});

test("before migration 0072 the cache reads as pending and backups still cover the database", async (t) => {
	const db = await database(t, copyMigrationsBefore(scratch, 72));
	const cached = await readCachedSummary(createDb(db), threadKey(), null);
	assert.deepEqual(cached, { pending: true, source: null, translation: null });
	await assertBackupTablesCoverDatabase(db);
});
