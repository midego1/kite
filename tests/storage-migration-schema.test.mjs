import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
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
	BACKUP_TABLE_GROUPS,
} = await bundleModules("kite-storage-schema-", [
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
	["assertBackupTablesCoverDatabase, exportDatabaseRecords, restoreDatabaseRecords", "src/lib/backups/export.ts"],
	["BACKUP_TABLE_GROUPS", "src/lib/backups/table-groups.ts"],
]);

const scratch = makeBundleDirectory("kite-storage-schema-dirs-");
after(() => rmSync(scratch, { recursive: true, force: true }));
const preDirectory = copyMigrationsBefore(scratch, 65);
const throughStorage = copyMigrationsBefore(scratch, 66);
const MIGRATION = "0065_add_storage_stores.sql";
const BACKED_UP = ["storage_stores", "storage_routes"];

async function database(t, dir = migrationsDir) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, dir);
	return db;
}

const all = (db, sql) => db.db.prepare(sql).all();
const columns = (db, table) => all(db, `PRAGMA table_info(${table})`).map((row) => row.name);
const encode = (document) => new TextEncoder().encode(JSON.stringify(document)).buffer;
const exportDocument = async (db) => JSON.parse(new TextDecoder().decode(await exportDatabaseRecords(db)));

function seedStorage(db, name, storeId = "sto_backup") {
	db.db.exec(`
		INSERT INTO storage_stores (id, name, provider, endpoint, region, bucket, credentials, created_at, updated_at)
			VALUES ('${storeId}', '${name}', 'minio', 'minio.example.test', 'us-east-1', 'kite', 'sealed:v1:invented', 1, 1);
		INSERT INTO storage_routes (object_class, store_id, updated_at) VALUES ('drive', '${storeId}', 1);
		INSERT INTO storage_migrations (id, object_class, from_store_id, to_store_id, created_at)
			VALUES ('mig_${storeId}', 'drive', 'default', '${storeId}', 1);
	`);
}

test("the journal lists 0065_add_storage_stores at idx 68 after 0064", () => {
	const journal = JSON.parse(readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8"));
	const index = journal.entries.findIndex((item) => item.tag === "0065_add_storage_stores");
	assert.equal(journal.entries[index].idx, 68);
	assert.equal(journal.entries[index - 1].tag, "0064_add_drive");
	assert.ok(journal.entries[index].when > journal.entries[index - 1].when);
});

test("0065 creates the storage tables with the spec's defaults", async (t) => {
	const db = await database(t);
	seedStorage(db, "Archive");
	assert.deepEqual(db.db.prepare("SELECT addressing, same_as_binding, status FROM storage_stores").get(), {
		addressing: "virtual",
		same_as_binding: 0,
		status: "unchecked",
	});
	assert.deepEqual(
		db.db
			.prepare("SELECT status, objects_total, objects_done, bytes_done, errors, cursor FROM storage_migrations")
			.get(),
		{ status: "queued", objects_total: 0, objects_done: 0, bytes_done: 0, errors: 0, cursor: null },
	);
	assert.ok(
		all(db, "PRAGMA index_list(storage_migrations)").some((row) => row.name === "storage_migrations_status_idx"),
	);
});

test("upgrading from 0064 adds only the storage tables and changes no existing one", async (t) => {
	const db = await database(t, preDirectory);
	seedAccountData(db);
	const tablesBefore = all(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);
	const before = Object.fromEntries(tablesBefore.map((table) => [table, columns(db, table)]));
	assert.deepEqual(await applyMigrations(db, throughStorage), [MIGRATION]);
	const tablesAfter = all(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);
	assert.deepEqual(
		tablesAfter.filter((table) => !tablesBefore.includes(table)),
		["storage_migrations", "storage_routes", "storage_stores"],
	);
	for (const [table, expected] of Object.entries(before)) assert.deepEqual(columns(db, table), expected, table);
});

test("stores and routes are backed up in the system group before app_settings; migrations are internal", async (t) => {
	const db = await database(t);
	await assertBackupTablesCoverDatabase(db);
	const order = Object.keys((await exportDocument(db)).tables);
	for (const table of BACKED_UP) assert.ok(order.indexOf(table) < order.indexOf("app_settings"), table);
	assert.ok(!order.includes("storage_migrations"));
	const groupOf = (table) =>
		BACKUP_TABLE_GROUPS.filter((group) => group.tables.includes(table)).map((group) => group.id);
	for (const table of BACKED_UP) assert.deepEqual(groupOf(table), ["system"], table);
	assert.deepEqual(groupOf("storage_migrations"), []);
});

test("a restore keeps the live storage config and never replays migration jobs", async (t) => {
	const source = await database(t);
	seedAccountData(source);
	seedStorage(source, "From the backup");
	const document = await exportDocument(source);
	assert.equal(document.tables.storage_stores.length, 1);
	assert.equal(document.tables.storage_migrations, undefined);

	const live = await database(t);
	seedAccountData(live);
	seedStorage(live, "Live store", "sto_live");
	await restoreDatabaseRecords(live, encode(document));
	assert.deepEqual(all(live, "SELECT id, name FROM storage_stores"), [{ id: "sto_live", name: "Live store" }]);
	assert.deepEqual(all(live, "SELECT object_class, store_id FROM storage_routes"), [
		{ object_class: "drive", store_id: "sto_live" },
	]);
	assert.equal(all(live, "SELECT id FROM messages").length, 2, "the rest of the backup is restored");
});

test("a restore merges cold storage rules and locations instead of keeping or replacing them wholesale", async (t) => {
	const source = await database(t);
	seedAccountData(source);
	seedStorage(source, "From the backup");
	source.db.exec(`
		INSERT INTO storage_cold_rules (object_class, after_days, min_bytes, target, enabled, updated_at)
			VALUES ('mail', 30, 0, 'sto_backup', 1, 1);
		INSERT INTO storage_cold_rules (object_class, after_days, min_bytes, target, enabled, updated_at)
			VALUES ('backups', 60, 0, 'sto_backup', 0, 1);
		INSERT INTO object_locations (key, object_class, store_id, storage_class, size, moved_at)
			VALUES ('inbound/from-backup.eml', 'mail', 'sto_backup', NULL, 10, 1);
	`);
	const document = await exportDocument(source);

	const live = await database(t);
	seedAccountData(live);
	seedStorage(live, "Live store", "sto_live");
	live.db.exec(`
		INSERT INTO storage_cold_rules (object_class, after_days, min_bytes, target, enabled, updated_at)
			VALUES ('drive', 14, 1024, 'sto_live', 1, 1);
		INSERT INTO storage_cold_rules (object_class, after_days, min_bytes, target, enabled, updated_at)
			VALUES ('backups', 90, 0, 'sto_live', 1, 1);
		INSERT INTO object_locations (key, object_class, store_id, storage_class, size, moved_at)
			VALUES ('drive/live-item', 'drive', 'sto_live', NULL, 20, 1);
	`);
	await restoreDatabaseRecords(live, encode(document));

	// storage_stores and storage_routes still keep only the live config outright (sealed credentials are not
	// something to merge silently); the cold storage tables below are the only ones that merge.
	assert.deepEqual(all(live, "SELECT id, name FROM storage_stores"), [{ id: "sto_live", name: "Live store" }]);

	// mail and drive have no live-vs-backup conflict: both the backup's mail rule and the live drive rule end
	// up present, so an object a sweep already moved before the backup is still found by the rule that moved
	// it, and the live drive rule the admin configured since is not lost either.
	assert.deepEqual(
		all(live, "SELECT object_class, after_days, target, enabled FROM storage_cold_rules ORDER BY object_class").map(
			(row) => ({ ...row, enabled: Boolean(row.enabled) }),
		),
		[
			{ object_class: "backups", after_days: 90, target: "sto_live", enabled: true },
			{ object_class: "drive", after_days: 14, target: "sto_live", enabled: true },
			{ object_class: "mail", after_days: 30, target: "sto_backup", enabled: true },
		],
	);
	// backups is the conflict case (both sides have one): the live row wins, exactly as storage_stores does.
	assert.equal(all(live, "SELECT target FROM storage_cold_rules WHERE object_class = 'backups'")[0].target, "sto_live");

	// Both the backup's and the live object's locations are present: a cold-moved object nothing but the
	// backup remembers the location of is not silently forgotten just because this install has its own.
	assert.deepEqual(all(live, "SELECT key, store_id FROM object_locations ORDER BY key"), [
		{ key: "drive/live-item", store_id: "sto_live" },
		{ key: "inbound/from-backup.eml", store_id: "sto_backup" },
	]);
	assert.equal(all(live, "SELECT id FROM messages").length, 2, "the rest of the backup is restored");
});

test("an install without storage config takes the backup's", async (t) => {
	const source = await database(t);
	seedAccountData(source);
	seedStorage(source, "From the backup");
	const document = await exportDocument(source);
	const empty = await database(t);
	await restoreDatabaseRecords(empty, encode(document));
	assert.deepEqual(all(empty, "SELECT id, name FROM storage_stores"), [{ id: "sto_backup", name: "From the backup" }]);
	assert.equal(all(empty, "SELECT id FROM storage_migrations").length, 0);
});

test("a backup taken before 0065 restores after it and leaves the storage tables as they were", async (t) => {
	const legacy = await database(t, preDirectory);
	seedAccountData(legacy);
	const document = await exportDocument(legacy);
	for (const table of BACKED_UP) {
		assert.deepEqual(document.tables[table] ?? [], [], table);
		delete document.tables[table];
	}
	// Code from before 0065 did not know these tables.
	document.includedTables = document.includedTables.filter((table) => !BACKED_UP.includes(table));
	const db = await database(t);
	seedStorage(db, "Live store", "sto_live");
	await restoreDatabaseRecords(db, encode(document));
	assert.equal(all(db, "SELECT id FROM storage_stores").length, 1);
	await assertBackupTablesCoverDatabase(db);
});
