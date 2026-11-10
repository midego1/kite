import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test, { after } from "node:test";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { copyMigrationsBefore, migrationsDir, seedAccountData } from "./support/module-database.mjs";
import { bundleModules } from "./support/modules-bundle.mjs";

// `setMailboxSemanticIndex` answers `migration_pending` before migration 0099, the same convention
// `setMailboxAiDisabled` uses for 0091 (S4 of review round 2): before, a save threw "no such column:
// semantic_index" instead, which the route only ever turned into a generic 500.

const { SqliteDatabase, applyMigrations, getMailboxAccessLevel, getDb, setMailboxSemanticIndex } = await bundleModules(
	"kite-semantic-mailbox-settings-",
	[
		["SqliteDatabase", "server/runtime/sqlite-database.ts"],
		["applyMigrations", "server/runtime/migrate.ts"],
		["getMailboxAccessLevel", "src/lib/mailboxes/access.ts"],
		["getDb", "src/db/index.ts"],
		["setMailboxSemanticIndex", "src/lib/semantic/mailbox-settings.ts"],
	],
);

const scratch = makeBundleDirectory("kite-semantic-mailbox-settings-dirs-");
after(() => rmSync(scratch, { recursive: true, force: true }));

const owner = { id: "owner" };

async function setup(t, migrations = migrationsDir) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, migrations);
	seedAccountData(db);
	const env = { DB: db };
	const access = await getMailboxAccessLevel(getDb(env), owner, "mailbox-a");
	assert.ok(access?.canManage);
	return { db, env, access };
}

test("before migration 0099 the switch answers migration_pending and touches nothing", async (t) => {
	const before = copyMigrationsBefore(scratch, 99);
	const { db, env, access } = await setup(t, before);
	const outcome = await setMailboxSemanticIndex(env, owner, access, true);
	assert.equal(outcome, "migration_pending");
	assert.equal(db.db.prepare("SELECT count(*) AS n FROM audit_logs").get().n, 0);
});

test("after migration 0099 the switch saves and audits", async (t) => {
	const { db, env, access } = await setup(t);
	const outcome = await setMailboxSemanticIndex(env, owner, access, false);
	assert.equal(outcome, "saved");
	assert.equal(
		db.db.prepare("SELECT semantic_index AS enabled FROM mailbox_agent_settings WHERE mailbox_id = 'mailbox-a'").get()
			.enabled,
		0,
	);
	assert.equal(
		db.db.prepare("SELECT count(*) AS n FROM audit_logs WHERE action = 'search.mailbox_semantic_index'").get().n,
		1,
	);
});

test("switching off again clears the mailbox even when the stored value is already off, so a retry after a failed cleanup works", async (t) => {
	const { db, env, access } = await setup(t);
	db.db.exec(`
		INSERT INTO app_settings (id, semantic_search_enabled, updated_at) VALUES ('default', 1, 1)
		ON CONFLICT(id) DO UPDATE SET semantic_search_enabled = 1;
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at)
		VALUES ('m1', 'owner', 'mailbox-a', 'inbound', 'x@example.net', 'a@example.com', 'Hi', 'Hello', 'received', 10);
	`);
	// The switch was stored as off by a save whose cleanup then failed: the row is still pending/indexed.
	await setMailboxSemanticIndex(env, owner, access, false);
	db.db.prepare("UPDATE message_embeddings SET status = 'pending' WHERE message_id = 'm1'").run();
	await setMailboxSemanticIndex(env, owner, access, false);
	assert.equal(db.db.prepare("SELECT status FROM message_embeddings WHERE message_id = 'm1'").get().status, "skipped");
	assert.equal(
		db.db.prepare("SELECT count(*) AS n FROM audit_logs WHERE action = 'search.mailbox_semantic_index'").get().n,
		1,
	);
});

test("a failing requeue puts the switch back, leaves no 'on' audit entry, and the retry runs it again", async (t) => {
	const { db, env, access } = await setup(t);
	db.db.exec(`
		INSERT INTO app_settings (id, semantic_search_enabled, updated_at) VALUES ('default', 1, 1)
		ON CONFLICT(id) DO UPDATE SET semantic_search_enabled = 1;
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at)
		VALUES ('m1', 'owner', 'mailbox-a', 'inbound', 'x@example.net', 'a@example.com', 'Hi', 'Hello', 'received', 10);
	`);
	await setMailboxSemanticIndex(env, owner, access, false);
	db.db.exec("UPDATE message_embeddings SET status = 'indexed' WHERE message_id = 'm1'");
	const audits = () =>
		db.db.prepare("SELECT count(*) AS n FROM audit_logs WHERE action = 'search.mailbox_semantic_index'").get().n;
	assert.equal(audits(), 1, "the switch off");
	const stored = () =>
		db.db.prepare("SELECT semantic_index AS on_ FROM mailbox_agent_settings WHERE mailbox_id = 'mailbox-a'").get().on_;

	// The requeue's UPDATE fails (a trigger stands in for a D1 error); the switch must read off again.
	db.db.exec(
		"CREATE TRIGGER fail_requeue BEFORE UPDATE OF status ON message_embeddings WHEN new.status = 'pending' BEGIN SELECT RAISE(ABORT, 'requeue failed'); END",
	);
	await assert.rejects(setMailboxSemanticIndex(env, owner, access, true), /requeue failed/);
	assert.equal(stored(), 0, "reverted");
	assert.equal(audits(), 1, "no 'on' entry for a switch that did not stay on");

	db.db.exec("DROP TRIGGER fail_requeue");
	assert.equal(await setMailboxSemanticIndex(env, owner, access, true), "saved");
	assert.equal(stored(), 1);
	assert.equal(audits(), 2, "the retry audits the change that stuck");
	assert.equal(db.db.prepare("SELECT status FROM message_embeddings WHERE message_id = 'm1'").get().status, "pending");
});
