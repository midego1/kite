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
} = await bundleModules("kite-backup-ai-writing-", [
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
	["assertBackupTablesCoverDatabase, exportDatabaseRecords, restoreDatabaseRecords", "src/lib/backups/export.ts"],
]);

const scratch = makeBundleDirectory("kite-backup-ai-writing-dirs-");
after(() => rmSync(scratch, { recursive: true, force: true }));
const preDirectory = copyMigrationsBefore(scratch, 69);

async function database(t, dir = migrationsDir) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, dir);
	return db;
}

const encode = (document) => new TextEncoder().encode(JSON.stringify(document)).buffer;
const exportDocument = async (db) => JSON.parse(new TextDecoder().decode(await exportDatabaseRecords(db)));
const all = (db, sql) => db.db.prepare(sql).all();

test("a backup taken before 0069 restores after it, with empty instruction fields and no personal settings", async (t) => {
	const legacy = await database(t, preDirectory);
	seedAccountData(legacy);
	legacy.db.exec(
		"INSERT INTO mailbox_agent_settings (mailbox_id, enabled, instructions, updated_at) VALUES ('mailbox-a', 1, 'Be brief.', 1)",
	);
	const document = await exportDocument(legacy);
	// Code from before 0069 did not know the table, so its documents omit it entirely.
	delete document.tables.user_ai_settings;
	document.includedTables = document.includedTables?.filter((table) => table !== "user_ai_settings");
	assert.equal("chat_instructions" in document.tables.mailbox_agent_settings[0], false);

	const db = await database(t);
	seedAccountData(db);
	db.db.exec(
		"INSERT INTO user_ai_settings (user_id, instructions, updated_at) VALUES ('owner', 'Only in the target.', 1)",
	);
	await restoreDatabaseRecords(db, encode(document));

	assert.deepEqual(all(db, "SELECT count(*) AS n FROM user_ai_settings"), [{ n: 0 }]);
	assert.deepEqual(
		all(
			db,
			"SELECT instructions, chat_instructions, draft_instructions, summary_instructions FROM mailbox_agent_settings",
		),
		[{ instructions: "Be brief.", chat_instructions: "", draft_instructions: "", summary_instructions: "" }],
	);
	await assertBackupTablesCoverDatabase(db);
});

test("a backup after 0069 round-trips personal settings and the mailbox's task instructions", async (t) => {
	const source = await database(t);
	seedAccountData(source);
	source.db.exec(`
		INSERT INTO mailbox_agent_settings (mailbox_id, enabled, instructions, chat_instructions, draft_instructions, summary_instructions, updated_at)
			VALUES ('mailbox-a', 1, 'Be brief.', 'Chat rule.', 'Draft rule.', 'Summary rule.', 1);
		INSERT INTO user_ai_settings (user_id, writing_style_enabled, instructions, chat_instructions, draft_instructions, summary_instructions, updated_at)
			VALUES ('owner', 0, 'I am the CFO.', 'Bullets.', 'Sign as O.', '', 2), ('member', 0, '', '', 'Use we.', '', 3);
	`);
	await assertBackupTablesCoverDatabase(source);
	const document = await exportDocument(source);
	assert.equal(document.tables.user_ai_settings.length, 2);
	const order = Object.keys(document.tables);
	assert.ok(order.indexOf("users") < order.indexOf("user_ai_settings"));
	assert.ok(order.indexOf("mailbox_agent_settings") < order.indexOf("user_ai_settings"));

	const target = await database(t);
	await restoreDatabaseRecords(target, encode(document));
	assert.deepEqual((await exportDocument(target)).tables, document.tables);
	assert.deepEqual(all(target, "SELECT user_id, draft_instructions FROM user_ai_settings ORDER BY user_id"), [
		{ user_id: "member", draft_instructions: "Use we." },
		{ user_id: "owner", draft_instructions: "Sign as O." },
	]);
});
