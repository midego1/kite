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
