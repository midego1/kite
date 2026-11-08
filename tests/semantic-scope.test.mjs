import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test, { after } from "node:test";
import { and, eq, ne } from "drizzle-orm";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { migrationsDir, seedAccountData } from "./support/module-database.mjs";
import { bundleModules } from "./support/modules-bundle.mjs";

// import.meta.resolve (plain strings in bundleModules's export list are invisible to it) lets knip see this test
// uses search.ts, so its exports are not reported as dead code.
void import.meta.resolve("../src/lib/semantic/search.ts");

const { SqliteDatabase, applyMigrations, semanticSearch, messages } = await bundleModules("kite-semantic-scope-", [
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
	["semanticSearch", "src/lib/semantic/search.ts"],
	["messages", "src/db/schema/index.ts"],
]);

const scratch = makeBundleDirectory("kite-semantic-scope-dirs-");
after(() => rmSync(scratch, { recursive: true, force: true }));

function insertMessage(db, id, overrides = {}) {
	const fields = {
		mailboxId: "mailbox-a",
		userId: "owner",
		status: "received",
		subject: "Hi",
		text: "Hello there",
		createdAt: 10,
		...overrides,
	};
	db.db
		.prepare(
			`INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at)
			VALUES (?, ?, ?, 'inbound', 'x@example.net', 'a@example.com', ?, ?, ?, ?)`,
		)
		.run(id, fields.userId, fields.mailboxId, fields.subject, fields.text, fields.status, fields.createdAt);
}

/** A vector store that always "finds" every seeded id, however it is scoped — the D1 re-check must still drop
 * anything that should not be visible, even when the store itself would not have scoped it correctly. */
function misbehavingVectorStore(hitIds) {
	return {
		upsert: async () => {},
		deleteByIds: async () => {},
		query: async () => hitIds.map((id, index) => ({ id, score: 0.9 - index * 0.01 })),
	};
}

async function setup(t) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, migrationsDir);
	seedAccountData(db); // already seeds users 'owner' and 'member'
	db.db.exec(`
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-b', 'owner', 'domain-1', 'b', 1);
		INSERT INTO app_settings (id, semantic_search_enabled, updated_at) VALUES ('default', 1, 1)
			ON CONFLICT(id) DO UPDATE SET semantic_search_enabled = 1;
	`);
	const env = { DB: db };
	return { db, env };
}

function vectorKeyRow(db, id, key) {
	// Feature is on, so an eligible message already has a trigger-created `pending` row; an ineligible one (a draft,
	// a screened message) does not. Either way, upsert it to `indexed` with the given vector key.
	db.db
		.prepare(
			`INSERT INTO message_embeddings (message_id, mailbox_id, status, vector_key, chunk_count)
			VALUES (?, (SELECT mailbox_id FROM messages WHERE id = ?), 'indexed', ?, 1)
			ON CONFLICT(message_id) DO UPDATE SET status = 'indexed', vector_key = excluded.vector_key, chunk_count = 1`,
		)
		.run(id, id, key);
}

/** The scope a real caller (`/api/messages`) would build: this mailbox only, never screening, drafts only the user's own. */
function buildScope(mailboxId) {
	return and(eq(messages.mailboxId, mailboxId), ne(messages.status, "screening"), ne(messages.status, "draft"));
}

// Real vector_key values are the first 32 hex characters of a SHA-256 digest; parseChunkVectorId only recognises
// that shape, so fixtures must look like one for the reverse lookup to actually exercise it.
const KEY_1 = "11111111111111111111111111111111".slice(0, 32);
const KEY_2 = "22222222222222222222222222222222".slice(0, 32);
const KEY_3 = "33333333333333333333333333333333".slice(0, 32);
const KEY_4 = "44444444444444444444444444444444".slice(0, 32);
const KEY_5 = "55555555555555555555555555555555".slice(0, 32);

test("the D1 re-check drops hits from another mailbox, another user's draft and a screened message even when the store returns them", async (t) => {
	const { db, env } = await setup(t);
	insertMessage(db, "visible-1", { subject: "Roof repair quote" });
	insertMessage(db, "other-mailbox-1", { mailboxId: "mailbox-b" });
	insertMessage(db, "members-draft", { status: "draft", userId: "member" });
	insertMessage(db, "screened", { status: "screening" });
	for (const [id, key] of [
		["visible-1", KEY_1],
		["other-mailbox-1", KEY_2],
		["members-draft", KEY_3],
		["screened", KEY_4],
	])
		vectorKeyRow(db, id, key);

	// The store "finds" all four ids, as if its own scoping had failed or an orphan survived a restore.
	env.VECTORS = misbehavingVectorStore([`${KEY_1}:0`, `${KEY_2}:0`, `${KEY_3}:0`, `${KEY_4}:0`]);
	env.AI = { run: async () => ({ data: [Array(1024).fill(0.01)] }) };

	const result = await semanticSearch({
		env,
		scopeWhere: buildScope("mailbox-a"),
		queryText: "roof repair",
		mailboxIds: ["mailbox-a"],
	});

	assert.deepEqual(result.ids, ["visible-1"]);
	assert.equal(result.semantic, "on");
});

test("a meaning-only hit (no shared words) is found through the vector key reverse lookup, kept by the D1 re-check, and labelled meaning", async (t) => {
	const { db, env } = await setup(t);
	// Dutch "roof repair quote" with no words in common with the English query: only the meaning path can find it.
	insertMessage(db, "dutch-quote", { subject: "Offerte dakwerk", text: "Bijgevoegd de offerte voor het dakwerk." });
	vectorKeyRow(db, "dutch-quote", KEY_5);
	env.VECTORS = {
		upsert: async () => {},
		deleteByIds: async () => {},
		query: async () => [{ id: `${KEY_5}:0`, score: 0.8 }],
	};
	env.AI = { run: async () => ({ data: [Array(1024).fill(0.01)] }) };

	const result = await semanticSearch({
		env,
		scopeWhere: buildScope("mailbox-a"),
		queryText: "the quote for the roof repair",
		mailboxIds: ["mailbox-a"],
	});
	assert.deepEqual(result.ids, ["dutch-quote"]);
	assert.equal(result.matches.get("dutch-quote"), "meaning");
});

test("the searching user's own draft is found and kept; another user's draft reaching the store is dropped by the re-check", async (t) => {
	const { db, env } = await setup(t);
	insertMessage(db, "own-draft", { status: "draft", userId: "owner", text: "Draft note about the roof" });
	insertMessage(db, "members-draft-2", {
		status: "draft",
		userId: "member",
		text: "Member's own draft, also about roofs",
	});
	vectorKeyRow(db, "own-draft", KEY_1);
	vectorKeyRow(db, "members-draft-2", KEY_2);
	env.VECTORS = misbehavingVectorStore([`${KEY_1}:0`, `${KEY_2}:0`]);
	env.AI = { run: async () => ({ data: [Array(1024).fill(0.01)] }) };

	const result = await semanticSearch({
		env,
		scopeWhere: and(
			eq(messages.mailboxId, "mailbox-a"),
			ne(messages.status, "screening"),
			eq(messages.userId, "owner"),
		),
		queryText: "draft note",
		mailboxIds: ["mailbox-a"],
	});
	assert.deepEqual(result.ids, ["own-draft"]);
});

test("a message found by both the keyword and the meaning search is labelled both", async (t) => {
	const { db, env } = await setup(t);
	insertMessage(db, "both-1", { subject: "Roof repair quote", text: "Please find the roof repair quote attached." });
	vectorKeyRow(db, "both-1", KEY_1);
	env.VECTORS = {
		upsert: async () => {},
		deleteByIds: async () => {},
		query: async () => [{ id: `${KEY_1}:0`, score: 0.8 }],
	};
	env.AI = { run: async () => ({ data: [Array(1024).fill(0.01)] }) };

	const result = await semanticSearch({
		env,
		scopeWhere: buildScope("mailbox-a"),
		queryText: "roof repair",
		mailboxIds: ["mailbox-a"],
	});
	assert.deepEqual(result.ids, ["both-1"]);
	assert.equal(result.matches.get("both-1"), "both");
});

test("when the feature is off, the meaning half is skipped and the keyword half still answers", async (t) => {
	const { db, env } = await setup(t);
	db.db.exec("UPDATE app_settings SET semantic_search_enabled = 0 WHERE id = 'default'");
	insertMessage(db, "keyword-only", { subject: "Roof repair quote" });
	let called = false;
	env.AI = {
		run: async () => {
			called = true;
			return { data: [Array(1024).fill(0.01)] };
		},
	};

	const result = await semanticSearch({
		env,
		scopeWhere: buildScope("mailbox-a"),
		queryText: "roof repair",
		mailboxIds: ["mailbox-a"],
	});
	assert.deepEqual(result.ids, ["keyword-only"]);
	assert.equal(result.semantic, "unavailable");
	assert.equal(result.semanticReason, "off");
	assert.equal(called, false, "no embedding call is made while the feature is off");
});

test("a query shorter than 3 characters is keyword-only, and not reported as unavailable", async (t) => {
	const { db, env } = await setup(t);
	insertMessage(db, "short-query", { subject: "ok" });
	let called = false;
	env.AI = {
		run: async () => {
			called = true;
			return { data: [Array(1024).fill(0.01)] };
		},
	};
	const result = await semanticSearch({
		env,
		scopeWhere: buildScope("mailbox-a"),
		queryText: "ok",
		mailboxIds: ["mailbox-a"],
	});
	assert.deepEqual(result.ids, ["short-query"]);
	assert.equal(result.semantic, "on");
	assert.equal(called, false);
});

test("a similarity score below the minimum is dropped before fusion", async (t) => {
	const { db, env } = await setup(t);
	insertMessage(db, "weak-match", { text: "Something unrelated" });
	vectorKeyRow(db, "weak-match", KEY_1);
	env.VECTORS = {
		upsert: async () => {},
		deleteByIds: async () => {},
		query: async () => [{ id: `${KEY_1}:0`, score: 0.1 }],
	};
	env.AI = { run: async () => ({ data: [Array(1024).fill(0.01)] }) };

	const result = await semanticSearch({
		env,
		scopeWhere: buildScope("mailbox-a"),
		queryText: "something else entirely",
		mailboxIds: ["mailbox-a"],
	});
	assert.deepEqual(result.ids, []);
});
