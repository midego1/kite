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
} = await bundleModules("kite-drive-migration-", [
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
	["assertBackupTablesCoverDatabase, exportDatabaseRecords, restoreDatabaseRecords", "src/lib/backups/export.ts"],
	["BACKUP_TABLE_GROUPS", "src/lib/backups/table-groups.ts"],
]);

const scratch = makeBundleDirectory("kite-drive-migration-dirs-");
after(() => rmSync(scratch, { recursive: true, force: true }));
const preDirectory = copyMigrationsBefore(scratch, 64);
const MIGRATION = "0064_add_drive.sql";
const BACKED_UP = ["drive_items", "drive_shares", "drive_links", "drive_settings", "drive_user_quotas"];
const TABLES = [...BACKED_UP, "drive_upload_parts"];

async function database(t, dir = migrationsDir) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, dir);
	return db;
}

const all = (db, sql) => db.db.prepare(sql).all();
const count = (db, table) => db.db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count;
const columns = (db, table) => all(db, `PRAGMA table_info(${table})`).map((row) => row.name);
const encode = (document) => new TextEncoder().encode(JSON.stringify(document)).buffer;
const exportDocument = async (db) => JSON.parse(new TextDecoder().decode(await exportDatabaseRecords(db)));

/** A folder with a file, a share with the member, a link, an upload part, settings and a quota override. */
function seedDrive(db) {
	db.db.exec(`
		INSERT INTO drive_items (id, owner_id, parent_id, kind, name, size, content_type, store_id, object_key, created_at, updated_at) VALUES
			('drv_folder', 'owner', NULL, 'folder', 'Plans', 0, 'application/octet-stream', NULL, NULL, 1, 1),
			('drv_file', 'owner', 'drv_folder', 'file', 'roadmap.pdf', 2048, 'application/pdf', 'default', 'drive/drv_file', 2, 2);
		INSERT INTO drive_items (id, owner_id, kind, name, size, status, store_id, object_key, upload_id, upload_part_size, upload_fingerprint, upload_expires_at, created_at, updated_at)
			VALUES ('drv_upload', 'owner', 'file', 'video.mp4', 40000000, 'uploading', 'default', 'drive/drv_upload', 'up-1', 33554432, 'fp', 99, 3, 3);
		INSERT INTO drive_shares (id, item_id, user_id, role, created_by_user_id, created_at) VALUES ('dsh_1', 'drv_folder', 'member', 'edit', 'owner', 4);
		INSERT INTO drive_links (id, item_id, token_hash, token_sealed, password_hash, expires_at, created_by_user_id, created_at)
			VALUES ('dln_1', 'drv_file', 'hash-1', NULL, NULL, 999, 'owner', 5);
		INSERT INTO drive_upload_parts (item_id, part_number, etag, size) VALUES ('drv_upload', 1, '1-2000000', 33554432);
		INSERT INTO drive_settings (id, default_quota_bytes, link_max_days, trash_retention_days, updated_at, updated_by) VALUES ('default', 1000000, 14, 7, 6, 'owner');
		INSERT INTO drive_user_quotas (user_id, quota_bytes, updated_at) VALUES ('member', NULL, 7);
	`);
}

test("the journal lists 0064_add_drive at idx 67 after 0063", () => {
	const journal = JSON.parse(readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8"));
	const index = journal.entries.findIndex((item) => item.tag === "0064_add_drive");
	assert.equal(journal.entries[index].idx, 67);
	assert.equal(journal.entries[index - 1].tag, "0063_add_finance_module");
	assert.ok(journal.entries[index].when > journal.entries[index - 1].when);
});

test("0064 creates the six Drive tables with the spec's defaults", async (t) => {
	const db = await database(t);
	seedAccountData(db);
	db.db.exec(
		"INSERT INTO drive_items (id, owner_id, kind, name, created_at, updated_at) VALUES ('d', 'owner', 'folder', 'F', 1, 1)",
	);
	assert.deepEqual(db.db.prepare("SELECT size, content_type, status, store_id, trashed_at FROM drive_items").get(), {
		size: 0,
		content_type: "application/octet-stream",
		status: "ready",
		store_id: null,
		trashed_at: null,
	});
	db.db.exec("INSERT INTO drive_settings (id, updated_at) VALUES ('default', 1)");
	assert.deepEqual(
		db.db.prepare("SELECT default_quota_bytes, link_max_days, trash_retention_days FROM drive_settings").get(),
		{ default_quota_bytes: null, link_max_days: 30, trash_retention_days: 30 },
	);
	assert.ok(columns(db, "drive_links").includes("token_hash"));
	assert.ok(!columns(db, "drive_items").includes("link_token"), "no plaintext link token column");
	assert.throws(
		() => db.db.exec("INSERT INTO drive_links (id, item_id, token_hash, created_at) VALUES ('l', 'd', 'h', 1)"),
		/NOT NULL constraint failed: drive_links.expires_at/,
		"every link has an expiry",
	);
});

test("shares, links and parts cascade with their item, and the item with its owner", async (t) => {
	const db = await database(t);
	seedAccountData(db);
	seedDrive(db);
	db.db.exec("PRAGMA foreign_keys = ON");
	assert.throws(
		() =>
			db.db.exec(
				"INSERT INTO drive_shares (id, item_id, user_id, created_at) VALUES ('dup', 'drv_folder', 'member', 9)",
			),
		/UNIQUE constraint failed/,
	);
	db.db.exec("DELETE FROM drive_items WHERE id IN ('drv_folder', 'drv_upload')");
	assert.equal(count(db, "drive_shares"), 0);
	assert.equal(count(db, "drive_upload_parts"), 0);
	assert.equal(count(db, "drive_links"), 1, "the file's link stays: parent_id has no foreign key");
	db.db.exec("DELETE FROM users WHERE id = 'owner'");
	assert.equal(count(db, "drive_items"), 0);
	assert.equal(count(db, "drive_links"), 0);
});

test("0064 inserts no module row", async (t) => {
	const db = await database(t);
	assert.equal(all(db, "SELECT module_id FROM module_settings WHERE module_id = 'drive'").length, 0);
});

test("upgrading from 0063 adds only the Drive tables and changes no existing one", async (t) => {
	const db = await database(t, preDirectory);
	seedAccountData(db);
	const tablesBefore = all(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);
	const before = Object.fromEntries(tablesBefore.map((table) => [table, columns(db, table)]));
	assert.deepEqual(await applyMigrations(db, migrationsDir), [MIGRATION]);
	const tablesAfter = all(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);
	assert.deepEqual(
		tablesAfter.filter((table) => !tablesBefore.includes(table)),
		[...TABLES].sort(),
	);
	for (const [table, expected] of Object.entries(before)) assert.deepEqual(columns(db, table), expected, table);
});

test("the Drive tables are backed up in the drive group after users; upload parts are internal", async (t) => {
	const db = await database(t);
	await assertBackupTablesCoverDatabase(db);
	const order = Object.keys((await exportDocument(db)).tables);
	for (const table of BACKED_UP) assert.ok(order.indexOf("users") < order.indexOf(table), table);
	assert.ok(order.indexOf("drive_items") < order.indexOf("drive_shares"));
	assert.ok(order.indexOf("drive_items") < order.indexOf("drive_links"));
	assert.ok(!order.includes("drive_upload_parts"));
	const groupOf = (table) =>
		BACKUP_TABLE_GROUPS.filter((group) => group.tables.includes(table)).map((group) => group.id);
	for (const table of BACKED_UP) assert.deepEqual(groupOf(table), ["drive"], table);
	assert.deepEqual(groupOf("drive_upload_parts"), []);
	const types = readFileSync(join(migrationsDir, "..", "..", "src/lib/backups/types.d.ts"), "utf8");
	for (const table of BACKED_UP) assert.ok(types.includes(`"${table}"`), `${table} is a DatabaseBackupTable`);
	assert.match(types, /"drive"/, "drive is a BackupTableGroupId");
});

test("a backup taken before 0064 restores after it with the Drive tables empty", async (t) => {
	const legacy = await database(t, preDirectory);
	seedAccountData(legacy);
	const document = await exportDocument(legacy);
	for (const table of BACKED_UP) {
		assert.deepEqual(document.tables[table] ?? [], [], table);
		delete document.tables[table];
	}
	// Code from before 0064 knew neither these tables nor excludedGroups.
	document.includedTables = document.includedTables.filter((table) => !BACKED_UP.includes(table));
	delete document.excludedGroups;
	const db = await database(t);
	seedAccountData(db);
	seedDrive(db);
	await restoreDatabaseRecords(db, encode(document));
	for (const table of BACKED_UP) assert.equal(count(db, table), 0, table);
	assert.equal(count(db, "messages"), 2);
	await assertBackupTablesCoverDatabase(db);
});

test("a backup after 0064 round-trips Drive metadata but not upload parts", async (t) => {
	const source = await database(t);
	seedAccountData(source);
	seedDrive(source);
	const document = await exportDocument(source);
	assert.equal(document.tables.drive_items.length, 3);
	assert.equal(document.tables.drive_upload_parts, undefined);
	const target = await database(t);
	await restoreDatabaseRecords(target, encode(document));
	assert.deepEqual((await exportDocument(target)).tables, document.tables);
	assert.equal(count(target, "drive_upload_parts"), 0);
	assert.deepEqual(all(target, "SELECT user_id, quota_bytes FROM drive_user_quotas"), [
		{ user_id: "member", quota_bytes: null },
	]);
});

test("restoring Drive rows into a database without 0064 asks for the pending migration", async (t) => {
	const source = await database(t);
	seedAccountData(source);
	seedDrive(source);
	const document = await exportDocument(source);
	const legacy = await database(t, preDirectory);
	seedAccountData(legacy);
	await assert.rejects(
		restoreDatabaseRecords(legacy, encode(document)),
		/Apply pending database migrations before restoring drive items\./,
	);
});

test("a backup without the drive group is refused once it records its excluded groups", async (t) => {
	const source = await database(t);
	seedAccountData(source);
	const partial = JSON.parse(new TextDecoder().decode(await exportDatabaseRecords(source, ["drive"])));
	assert.deepEqual(partial.excludedGroups, ["drive"]);
	assert.ok(!partial.includedTables.includes("drive_items"));
	const target = await database(t);
	await assert.rejects(restoreDatabaseRecords(target, encode(partial)), /selected table groups only/);
	assert.deepEqual((await exportDocument(source)).excludedGroups, []);
});

test("a document without excludedGroups must still cover every group that predates drive", async (t) => {
	const source = await database(t);
	seedAccountData(source);
	const document = await exportDocument(source);
	delete document.excludedGroups;
	const routing = ["routing_rules", "webhooks", "webhook_deliveries"];
	document.includedTables = document.includedTables.filter((table) => !routing.includes(table));
	for (const table of routing) delete document.tables[table];
	const target = await database(t);
	await assert.rejects(restoreDatabaseRecords(target, encode(document)), /selected table groups only/);
});

test("a malformed excludedGroups field makes the document invalid", async (t) => {
	const source = await database(t);
	const document = await exportDocument(source);
	document.excludedGroups = "drive";
	await assert.rejects(restoreDatabaseRecords(source, encode(document)), /not a valid Kite backup/);
});
