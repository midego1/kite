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
} = await bundleModules("kite-backup-user-preferences-", [
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
	["assertBackupTablesCoverDatabase, exportDatabaseRecords, restoreDatabaseRecords", "src/lib/backups/export.ts"],
]);

const scratch = makeBundleDirectory("kite-backup-user-preferences-dirs-");
after(() => rmSync(scratch, { recursive: true, force: true }));
const preDirectory = copyMigrationsBefore(scratch, 80);

async function database(t, dir = migrationsDir) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, dir);
	return db;
}

const encode = (document) => new TextEncoder().encode(JSON.stringify(document)).buffer;
const exportDocument = async (db) => JSON.parse(new TextDecoder().decode(await exportDatabaseRecords(db)));
const all = (db, sql) => db.db.prepare(sql).all();

test("a database from before 0080 backs up, and its backup restores after it with no saved layouts", async (t) => {
	const legacy = await database(t, preDirectory);
	seedAccountData(legacy);
	await assertBackupTablesCoverDatabase(legacy);
	const document = await exportDocument(legacy);
	// Code from before 0080 did not know the table, so its documents omit it entirely.
	delete document.tables.user_preferences;
	document.includedTables = document.includedTables?.filter((table) => table !== "user_preferences");

	const db = await database(t);
	seedAccountData(db);
	db.db.exec(
		"INSERT INTO user_preferences (user_id, layout, updated_at) VALUES ('owner', '{\"density\":\"compact\"}', 1)",
	);
	await restoreDatabaseRecords(db, encode(document));
	assert.deepEqual(all(db, "SELECT count(*) AS n FROM user_preferences"), [{ n: 0 }]);
	await assertBackupTablesCoverDatabase(db);
});

test("saved layouts round-trip after their users", async (t) => {
	const source = await database(t);
	seedAccountData(source);
	source.db.exec(`
		INSERT INTO user_preferences (user_id, layout, updated_at) VALUES
			('owner', '{"readingPane":"below","listWidth":420}', 2),
			('member', '{"conversationView":false}', 3);
	`);
	await assertBackupTablesCoverDatabase(source);
	const document = await exportDocument(source);
	assert.equal(document.tables.user_preferences.length, 2);
	const order = Object.keys(document.tables);
	assert.ok(order.indexOf("users") < order.indexOf("user_preferences"));

	const target = await database(t);
	await restoreDatabaseRecords(target, encode(document));
	assert.deepEqual((await exportDocument(target)).tables, document.tables);
	assert.deepEqual(all(target, "SELECT user_id, layout FROM user_preferences ORDER BY user_id"), [
		{ user_id: "member", layout: '{"conversationView":false}' },
		{ user_id: "owner", layout: '{"readingPane":"below","listWidth":420}' },
	]);
});
