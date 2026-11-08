import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test, { after } from "node:test";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
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
		INSERT INTO ai_usage (id, created_at, provider, model, source, cost_usd_micros, reserved) VALUES ('u1', strftime('%s','now'), 'cloudflare', '@cf/baai/bge-m3', 'embedding', 600, 0);
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
