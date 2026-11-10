import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test, { after } from "node:test";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { D1_BOUND_PARAMETER_LIMIT, limitBoundParameters } from "./support/jmap-database.mjs";
import { migrationsDir, seedAccountData } from "./support/module-database.mjs";
import { bundleModules } from "./support/modules-bundle.mjs";

const { SqliteDatabase, applyMigrations, processEmbeddingBatch } = await bundleModules("kite-semantic-spend-", [
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
	["processEmbeddingBatch", "src/lib/semantic/indexer.ts"],
]);
const { runSemanticBackfillTick } = await bundleModules("kite-semantic-spend-backfill-", [
	["runSemanticBackfillTick", "src/lib/semantic/backfill.ts"],
]);

const scratch = makeBundleDirectory("kite-semantic-spend-dirs-");
after(() => rmSync(scratch, { recursive: true, force: true }));

function fakeVectors(count) {
	return Array.from({ length: count }, () => Array.from({ length: 1024 }, () => 0.01));
}

async function setup(t, overrides = "") {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, migrationsDir);
	seedAccountData(db);
	db.db.exec(`
		INSERT INTO app_settings (id, semantic_search_enabled, updated_at) VALUES ('default', 1, 1)
		ON CONFLICT(id) DO UPDATE SET semantic_search_enabled = 1;
		${overrides}
	`);
	const env = { DB: db, VECTORS: { upsert: async () => {}, deleteByIds: async () => {}, query: async () => [] } };
	return { db, env };
}

function insertEligibleMessage(db, id) {
	db.db.exec(`
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at)
		VALUES ('${id}', 'owner', 'mailbox-a', 'inbound', 'x@example.net', 'a@example.com', 'Hi', 'Hello there', 'received', 10);
	`);
}

test("a compatible provider without the external-provider opt-in embeds nothing", async (t) => {
	const { db, env } = await setup(
		t,
		"UPDATE app_settings SET semantic_embedding_provider = 'compatible', semantic_compatible_base_url = 'https://embeddings.example.com' WHERE id = 'default';",
	);
	insertEligibleMessage(db, "m1");
	// No env.AI, no CF_ACCOUNT_ID/CF_TOKEN: the only path left is the compatible endpoint, which needs the opt-in
	// (agent_external_auto_read_allowed), off by default.
	let called = false;
	global.fetch = async () => {
		called = true;
		return new Response("{}", { status: 200 });
	};
	try {
		const result = await processEmbeddingBatch(env);
		assert.equal(result.claimed, 0);
		assert.equal(called, false);
		assert.equal(
			db.db.prepare("SELECT status FROM message_embeddings WHERE message_id = 'm1'").get().status,
			"pending",
		);
	} finally {
		delete global.fetch;
	}
});

test("the backfill stops inserting once today's embedding spend reaches its share of the install cap; live indexing still reaches the full cap", async (t) => {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, migrationsDir);
	seedAccountData(db);
	// The feature is off while this message arrives, so the trigger gives it no row: exactly what the backfill
	// (never the trigger) is meant to find.
	insertEligibleMessage(db, "old-message");
	db.db.exec(`
		INSERT INTO app_settings (id, semantic_search_enabled, agent_daily_spend_cap_micros, semantic_backfill_cap_share, updated_at)
			VALUES ('default', 1, 1000, 50, 1)
			ON CONFLICT(id) DO UPDATE SET semantic_search_enabled = 1, agent_daily_spend_cap_micros = 1000, semantic_backfill_cap_share = 50;
		INSERT INTO ai_usage (id, created_at, provider, model, source, cost_usd_micros, reserved) VALUES ('u1', strftime('%s','now'), 'cloudflare', '@cf/baai/bge-m3', 'embedding_backfill', 600, 0);
	`);
	const env = { DB: db, VECTORS: { upsert: async () => {}, deleteByIds: async () => {}, query: async () => [] } };
	await runSemanticBackfillTick(env);
	assert.deepEqual(
		db.db.prepare("SELECT message_id FROM message_embeddings WHERE message_id = 'old-message'").all(),
		[],
	);

	// Live indexing (a trigger-queued row) is not blocked by the backfill's share: it still reaches the full cap.
	insertEligibleMessage(db, "new-message");
	assert.equal(
		db.db.prepare("SELECT status FROM message_embeddings WHERE message_id = 'new-message'").get().status,
		"pending",
	);
	env.AI = { run: async (_model, input) => ({ data: fakeVectors(input.text.length) }) };
	const result = await processEmbeddingBatch(env);
	assert.equal(result.claimed, 1);
	assert.equal(
		db.db.prepare("SELECT status FROM message_embeddings WHERE message_id = 'new-message'").get().status,
		"indexed",
	);
});

test("a backfill-origin row is left unclaimed once the backfill's own share is spent, but a live row in the same batch still embeds", async (t) => {
	const { db, env } = await setup(
		t,
		`UPDATE app_settings SET agent_daily_spend_cap_micros = 1000, semantic_backfill_cap_share = 50;
		INSERT INTO ai_usage (id, created_at, provider, model, source, cost_usd_micros, reserved) VALUES ('u1', strftime('%s','now'), 'cloudflare', '@cf/baai/bge-m3', 'embedding_backfill', 600, 0);`,
	);
	// A row the backfill queued before its share ran out (queued_at set to a message date, well past
	// BACKFILL_AGE_MARGIN_MS, exactly as backfill.ts itself queues one), and an ordinary trigger-queued row.
	insertEligibleMessage(db, "backfilled");
	db.db.exec("UPDATE message_embeddings SET queued_at = 10 WHERE message_id = 'backfilled'");
	insertEligibleMessage(db, "live");
	env.AI = { run: async (_model, input) => ({ data: fakeVectors(input.text.length) }) };
	const result = await processEmbeddingBatch(env);
	// Left out of the claim entirely (S3 of review round 2), not claimed and given back: with the cap already
	// spent, there is no point loading its body only to find that out again at embed time.
	assert.equal(result.claimed, 1);
	assert.equal(
		db.db.prepare("SELECT status FROM message_embeddings WHERE message_id = 'backfilled'").get().status,
		"pending",
		"never claimed while the backfill's own share is spent",
	);
	assert.equal(
		db.db.prepare("SELECT status FROM message_embeddings WHERE message_id = 'live'").get().status,
		"indexed",
		"never throttled by the backfill's share",
	);
});

test("once the full install cap is reached, no more embedding spend is reserved, and the claim is released back to pending", async (t) => {
	const { db, env } = await setup(
		t,
		`UPDATE app_settings SET agent_daily_spend_cap_micros = 1 WHERE id = 'default';
		INSERT INTO ai_usage (id, created_at, provider, model, source, cost_usd_micros, reserved) VALUES ('u1', strftime('%s','now'), 'cloudflare', '@cf/baai/bge-m3', 'embedding', 1, 0);`,
	);
	insertEligibleMessage(db, "m1");
	let called = false;
	env.AI = {
		run: async () => {
			called = true;
			return { data: [] };
		},
	};
	const result = await processEmbeddingBatch(env);
	assert.equal(result.claimed, 1);
	assert.equal(called, false, "the provider is never called once the cap refuses the reservation");
	assert.equal(db.db.prepare("SELECT status FROM message_embeddings WHERE message_id = 'm1'").get().status, "pending");
});

test("the backfill inserts nothing while the pending queue is already deep enough to keep a drain tick busy", async (t) => {
	const { db, env } = await setup(t);
	// A deep backlog already queued (well past PENDING_BACKLOG_LIMIT), none of it this test's doing.
	const rows = Array.from(
		{ length: 300 },
		(_, index) =>
			`('backlog-${index}', 'owner', 'mailbox-a', 'inbound', 'x@example.net', 'a@example.com', 'Hi', 'Hello', 'received', ${index})`,
	).join(",\n");
	db.db.exec(
		`INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at) VALUES ${rows};`,
	);
	assert.equal(db.db.prepare("SELECT count(*) AS n FROM message_embeddings WHERE status = 'pending'").get().n, 300);

	// A message that arrived before the feature was ever on, so the trigger gave it no row: exactly what the
	// backfill alone could find, if the deep backlog above did not hold it back.
	db.db.exec("UPDATE app_settings SET semantic_search_enabled = 0 WHERE id = 'default'");
	insertEligibleMessage(db, "should-not-be-queued-yet");
	db.db.exec("UPDATE app_settings SET semantic_search_enabled = 1 WHERE id = 'default'");
	assert.deepEqual(
		db.db.prepare("SELECT message_id FROM message_embeddings WHERE message_id = 'should-not-be-queued-yet'").all(),
		[],
	);

	await runSemanticBackfillTick(env);
	assert.deepEqual(
		db.db.prepare("SELECT message_id FROM message_embeddings WHERE message_id = 'should-not-be-queued-yet'").all(),
		[],
	);
});

test("the backfill inserts pending rows for more candidates than one insert chunk without exceeding D1's bound-parameter limit (R1 of review round 2)", async (t) => {
	const { db, env } = await setup(t);
	// Off while these are delivered, so the trigger gives them no row: exactly what makes the backfill's own insert
	// the one under test here, not the trigger's (same trick the backlog test above uses).
	db.db.exec("UPDATE app_settings SET semantic_search_enabled = 0 WHERE id = 'default'");
	const count = 45; // several times INSERT_CHUNK_SIZE (20), so the fix is exercised across multiple chunks.
	const rows = Array.from(
		{ length: count },
		(_, index) =>
			`('candidate-${index}', 'owner', 'mailbox-a', 'inbound', 'x@example.net', 'a@example.com', 'Hi', 'Hello', 'received', ${index})`,
	).join(",\n");
	db.db.exec(
		`INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at) VALUES ${rows};`,
	);
	db.db.exec("UPDATE app_settings SET semantic_search_enabled = 1 WHERE id = 'default'");
	assert.equal(db.db.prepare("SELECT count(*) AS n FROM message_embeddings").get().n, 0);

	const stats = limitBoundParameters(db);
	await runSemanticBackfillTick(env);
	assert.ok(stats.maxBound <= D1_BOUND_PARAMETER_LIMIT, `bound ${stats.maxBound}`);
	// seedAccountData's own "message-1" in mailbox-a also has no row yet (semantic search was off when it was
	// seeded), so the backfill picks it up too, same as these candidates.
	const { n } = db.db.prepare("SELECT count(*) AS n FROM message_embeddings WHERE status = 'pending'").get();
	assert.equal(n, count + 1);
});
