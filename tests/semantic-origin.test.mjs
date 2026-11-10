import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test, { after } from "node:test";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { copyMigrationsBefore, migrationsDir, seedAccountData } from "./support/module-database.mjs";
import { bundleModules } from "./support/modules-bundle.mjs";

const {
	SqliteDatabase,
	applyMigrations,
	processEmbeddingBatch,
	runSemanticBackfillTick,
	rebuildSemanticIndex,
	requeueMailboxSemanticIndex,
} = await bundleModules("kite-semantic-origin-", [
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
	["processEmbeddingBatch", "src/lib/semantic/indexer.ts"],
	["runSemanticBackfillTick", "src/lib/semantic/backfill.ts"],
	["rebuildSemanticIndex, requeueMailboxSemanticIndex", "src/lib/semantic/admin-actions.ts"],
]);

const scratch = makeBundleDirectory("kite-semantic-origin-dirs-");
after(() => rmSync(scratch, { recursive: true, force: true }));

const fakeVectors = (count) => Array.from({ length: count }, () => Array.from({ length: 1024 }, () => 0.01));
const CAPPED = `UPDATE app_settings SET agent_daily_spend_cap_micros = 1000, semantic_backfill_cap_share = 50;
	INSERT INTO ai_usage (id, created_at, provider, model, source, cost_usd_micros, reserved) VALUES ('u1', strftime('%s','now'), 'cloudflare', '@cf/baai/bge-m3', 'embedding_backfill', 600, 0);`;

async function setup(t, { dir = migrationsDir, extra = "" } = {}) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, dir);
	seedAccountData(db);
	db.db.exec(`
		INSERT INTO app_settings (id, semantic_search_enabled, updated_at) VALUES ('default', 1, 1)
		ON CONFLICT(id) DO UPDATE SET semantic_search_enabled = 1;
		${extra}
	`);
	const env = {
		DB: db,
		AI: { run: async (_model, input) => ({ data: fakeVectors(input.text.length) }) },
		VECTORS: { upsert: async () => {}, deleteByIds: async () => {}, query: async () => [] },
	};
	return { db, env };
}

function insertEligibleMessage(db, id, createdAt = 10) {
	db.db.exec(`
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at)
		VALUES ('${id}', 'owner', 'mailbox-a', 'inbound', 'x@example.net', 'a@example.com', 'Hi', 'Hello there', 'received', ${createdAt});
	`);
}

const row = (db, id) => db.db.prepare("SELECT status, origin FROM message_embeddings WHERE message_id = ?").get(id);

test("origin defaults to live, and only the backfill's insert writes backfill", async (t) => {
	const { db, env } = await setup(t);
	// Eligible mail that arrived while the feature was off has no row until the backfill finds it.
	db.db.exec("UPDATE app_settings SET semantic_search_enabled = 0 WHERE id = 'default'");
	insertEligibleMessage(db, "old-message");
	db.db.exec("UPDATE app_settings SET semantic_search_enabled = 1 WHERE id = 'default'");
	insertEligibleMessage(db, "delivered");
	await runSemanticBackfillTick(env);
	assert.equal(row(db, "old-message").origin, "backfill");
	assert.equal(row(db, "delivered").origin, "live", "the trigger's own row keeps the default");
});

test("a live row is never taken for the backfill's because it is old, nor a backfill row for live because it is new", async (t) => {
	const { db, env } = await setup(t, { extra: CAPPED });
	// Queued an hour ago but live (a delivery the drain could not reach, say): the age rule would have held it back.
	insertEligibleMessage(db, "stuck-live");
	db.db.exec(`UPDATE message_embeddings SET queued_at = strftime('%s','now') - 3600 WHERE message_id = 'stuck-live'`);
	// Queued just now but by the backfill: the age rule would have charged it as live.
	insertEligibleMessage(db, "fresh-backfill");
	db.db.exec(
		`UPDATE message_embeddings SET queued_at = strftime('%s','now'), origin = 'backfill' WHERE message_id = 'fresh-backfill'`,
	);
	const result = await processEmbeddingBatch(env);
	assert.equal(result.claimed, 1, "only the live row is claimed while the backfill's share is spent");
	assert.equal(row(db, "stuck-live").status, "indexed");
	assert.equal(row(db, "fresh-backfill").status, "pending");
	const sources = db.db.prepare("SELECT source FROM ai_usage WHERE id <> 'u1'").all();
	assert.deepEqual(
		sources.map((usage) => usage.source),
		["embedding"],
		"charged to live spend",
	);
});

test("a backfill row under its cap share is embedded and charged to the backfill's own source", async (t) => {
	const { db, env } = await setup(t);
	insertEligibleMessage(db, "page");
	db.db.exec(
		`UPDATE message_embeddings SET queued_at = strftime('%s','now'), origin = 'backfill' WHERE message_id = 'page'`,
	);
	assert.equal((await processEmbeddingBatch(env)).claimed, 1);
	assert.equal(row(db, "page").status, "indexed");
	assert.deepEqual(
		db.db
			.prepare("SELECT source FROM ai_usage")
			.all()
			.map((usage) => usage.source),
		["embedding_backfill"],
	);
});

test("rebuild and mailbox requeue make every row live work again", async (t) => {
	const { db, env } = await setup(t);
	insertEligibleMessage(db, "a");
	insertEligibleMessage(db, "b");
	db.db.exec("UPDATE message_embeddings SET status = 'indexed', origin = 'backfill'");
	await rebuildSemanticIndex(env);
	assert.deepEqual(
		[row(db, "a"), row(db, "b")],
		[
			{ status: "pending", origin: "live" },
			{ status: "pending", origin: "live" },
		],
	);

	db.db.exec("UPDATE message_embeddings SET status = 'indexed', origin = 'backfill'");
	await requeueMailboxSemanticIndex(env, "mailbox-a");
	assert.deepEqual(
		[row(db, "a"), row(db, "b")],
		[
			{ status: "pending", origin: "live" },
			{ status: "pending", origin: "live" },
		],
	);
});

test("a message coming back from spam or trash through the status trigger is live again", async (t) => {
	const { db } = await setup(t);
	insertEligibleMessage(db, "revived");
	db.db.exec(`UPDATE message_embeddings SET status = 'skipped', origin = 'backfill' WHERE message_id = 'revived'`);
	db.db.exec("UPDATE messages SET status = 'trash' WHERE id = 'revived'");
	db.db.exec("UPDATE messages SET status = 'received' WHERE id = 'revived'");
	assert.deepEqual(row(db, "revived"), { status: "pending", origin: "live" });
});

test("migration 0110 keeps the backfill's waiting rows classified, and leaves recent and finished rows live", async (t) => {
	const dir = copyMigrationsBefore(scratch, 110);
	const { db } = await setup(t, { dir });
	for (const id of ["queued-long-ago", "queued-just-now", "already-indexed"]) insertEligibleMessage(db, id);
	db.db.exec(`
		UPDATE message_embeddings SET queued_at = 10 WHERE message_id = 'queued-long-ago';
		UPDATE message_embeddings SET queued_at = 10, status = 'indexed' WHERE message_id = 'already-indexed';
	`);
	await applyMigrations(db, migrationsDir);
	assert.equal(row(db, "queued-long-ago").origin, "backfill");
	assert.equal(row(db, "queued-just-now").origin, "live");
	assert.equal(row(db, "already-indexed").origin, "live");
});

test("before migration 0110 the drain, the backfill and the requeues fall back to the age rule instead of failing", async (t) => {
	const dir = copyMigrationsBefore(scratch, 110);
	const { db, env } = await setup(t, { dir, extra: CAPPED });
	assert.equal(
		db.db.prepare("SELECT count(*) AS n FROM pragma_table_info('message_embeddings') WHERE name = 'origin'").get().n,
		0,
	);
	insertEligibleMessage(db, "old-page");
	db.db.exec("UPDATE message_embeddings SET queued_at = 10 WHERE message_id = 'old-page'");
	insertEligibleMessage(db, "live");
	const result = await processEmbeddingBatch(env);
	assert.equal(result.claimed, 1, "the old-queued row is the backfill's by age, and the share is spent");
	assert.equal(row_(db, "old-page").status, "pending");
	assert.equal(row_(db, "live").status, "indexed");

	// The backfill inserts its page without the column, and the two requeues work.
	db.db.exec("UPDATE app_settings SET semantic_search_enabled = 0 WHERE id = 'default'");
	insertEligibleMessage(db, "never-queued");
	db.db.exec(
		"UPDATE app_settings SET semantic_search_enabled = 1, agent_daily_spend_cap_micros = 100000 WHERE id = 'default'",
	);
	db.db.exec("DELETE FROM ai_usage");
	await runSemanticBackfillTick(env);
	assert.equal(row_(db, "never-queued").status, "pending");
	await rebuildSemanticIndex(env);
	await requeueMailboxSemanticIndex(env, "mailbox-a");
	assert.equal(row_(db, "live").status, "pending");
});

const row_ = (db, id) => db.db.prepare("SELECT status FROM message_embeddings WHERE message_id = ?").get(id);
