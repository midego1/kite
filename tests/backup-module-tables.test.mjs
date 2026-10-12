import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test, { after } from "node:test";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import {
	copyMigrationsBefore,
	migrationsDir,
	seedAccountData,
	seedBookingAppointment,
	seedModuleState,
} from "./support/module-database.mjs";
import { bundleModules } from "./support/modules-bundle.mjs";

const {
	SqliteDatabase,
	applyMigrations,
	assertBackupTablesCoverDatabase,
	exportDatabaseRecords,
	restoreDatabaseRecords,
	listEnabledModules,
	getUserModuleAccess,
} = await bundleModules("kite-backup-module-tables-", [
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
	["assertBackupTablesCoverDatabase, exportDatabaseRecords, restoreDatabaseRecords", "src/lib/backups/export.ts"],
	["listEnabledModules, getUserModuleAccess", "src/lib/modules/state.ts"],
]);

const scratch = makeBundleDirectory("kite-backup-module-tables-dirs-");
after(() => rmSync(scratch, { recursive: true, force: true }));
const preDirectory = copyMigrationsBefore(scratch, 62);
const NEW_TABLES = ["module_settings", "user_module_access", "booking_appointments"];
const ALL = ["calendar", "booking", "templates", "import"];
const MEMBER = { userId: "member", role: "user", isPrimaryAdmin: false };

async function database(t, dir = migrationsDir) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, dir);
	return db;
}

const encode = (document) => new TextEncoder().encode(JSON.stringify(document)).buffer;
const exportDocument = async (db) => JSON.parse(new TextDecoder().decode(await exportDatabaseRecords(db)));
const all = (db, sql) => db.db.prepare(sql).all();
/** A binding with an empty isolate cache: a restore does not clear the 30-second module state cache. */
const uncached = (db) => ({ DB: Object.create(db) });
const count = (db, table) => db.db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count;

/** The calendar events a search for `term` finds, through the index the triggers maintain. */
function found(db, term) {
	return all(
		db,
		`SELECT id FROM calendar_events WHERE rowid IN (SELECT rowid FROM calendar_events_fts WHERE calendar_events_fts MATCH '${term}') ORDER BY id`,
	).map((row) => row.id);
}

test("a backup taken before 0062 restores after 0062 with every module on and every user allowed", async (t) => {
	const legacy = await database(t, preDirectory);
	seedAccountData(legacy);
	const document = await exportDocument(legacy);
	// Code from before 0062 did not know these tables, so its documents omit them entirely.
	for (const table of NEW_TABLES) {
		assert.deepEqual(document.tables[table] ?? [], [], table);
		delete document.tables[table];
	}
	document.includedTables = document.includedTables?.filter((table) => !NEW_TABLES.includes(table));
	assert.equal(document.tables.calendar_events.length, 2);

	// The target has changed module state, a restricted user, an appointment and an event the backup lacks.
	const db = await database(t);
	seedAccountData(db);
	seedModuleState(db);
	db.db.exec(
		"INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, created_at, updated_at) VALUES ('extra', 'owner', 'Only here', 1, 2, 1, 1)",
	);
	assert.deepEqual(await listEnabledModules({ DB: db }, MEMBER), ["import"]);

	await restoreDatabaseRecords(db, encode(document));

	for (const table of NEW_TABLES) assert.equal(count(db, table), 0, table);
	assert.equal(count(db, "calendar_events"), 2);
	assert.equal(count(db, "booking_events"), 1);
	assert.deepEqual(
		all(db, "SELECT id, title, description, location, attendees FROM calendar_events ORDER BY id"),
		document.tables.calendar_events.map(({ id, title, description, location, attendees }) => ({
			id,
			title,
			description,
			location,
			attendees,
		})),
	);
	assert.deepEqual(all(db, "SELECT id, name, slug FROM booking_events"), [
		{ id: "type-1", name: "Intro", slug: "intro" },
	]);
	assert.equal(count(db, "messages"), 2);

	const env = uncached(db);
	assert.deepEqual(await listEnabledModules(env, MEMBER), ALL);
	assert.deepEqual(
		[...(await getUserModuleAccess(env, MEMBER))],
		ALL.map((id) => [id, true]),
	);
	await assertBackupTablesCoverDatabase(db);
});

test("a pre-0062 restore rebuilds the calendar search index from the restored events", async (t) => {
	const legacy = await database(t, preDirectory);
	seedAccountData(legacy);
	const document = await exportDocument(legacy);
	const db = await database(t);
	db.db.exec(
		"INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('owner', 'o@example.com', 'hash', 'Owner', 1)",
	);
	db.db.exec(
		"INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, created_at, updated_at) VALUES ('stale', 'owner', 'Stale entry', 1, 2, 1, 1)",
	);
	assert.deepEqual(found(db, "stale"), ["stale"]);
	await restoreDatabaseRecords(db, encode(document));
	assert.deepEqual(found(db, "stale"), []);
	assert.deepEqual(found(db, "cafe"), ["event-1"]);
	assert.deepEqual(found(db, "video"), ["event-2"]);
	db.db.prepare("INSERT INTO calendar_events_fts(calendar_events_fts) VALUES ('integrity-check')").run();
});

test("a backup after 0062 round-trips module state, user access and appointments", async (t) => {
	const source = await database(t);
	seedAccountData(source);
	seedModuleState(source);
	await assertBackupTablesCoverDatabase(source);
	const document = await exportDocument(source);
	assert.deepEqual(
		document.tables.module_settings.map((row) => [row.module_id, row.enabled]),
		[
			["calendar", 1],
			["booking", 1],
			["templates", 0],
			["import", 1],
		],
	);
	assert.equal(document.tables.user_module_access.length, 1);
	assert.equal(document.tables.booking_appointments.length, 1);
	const order = Object.keys(document.tables);
	assert.ok(order.indexOf("booking_events") < order.indexOf("calendar_events"));
	assert.ok(order.indexOf("calendar_events") < order.indexOf("booking_appointments"));

	// Into a fresh migrated database that starts at the defaults.
	const target = await database(t);
	await restoreDatabaseRecords(target, encode(document));
	assert.deepEqual((await exportDocument(target)).tables, document.tables);
	const env = uncached(target);
	assert.deepEqual(await listEnabledModules(env, { userId: "owner", role: "admin", isPrimaryAdmin: true }), [
		"calendar",
		"booking",
		"import",
	]);
	assert.deepEqual(await listEnabledModules(env, MEMBER), ["import"]);
	assert.deepEqual(all(target, "SELECT calendar_event_id, booking_event_id FROM booking_appointments"), [
		{ calendar_event_id: "event-2", booking_event_id: "type-1" },
	]);
	assert.deepEqual(found(target, "cafe"), ["event-1"]);
	assert.deepEqual(found(target, "video"), ["event-2"]);
	assert.equal(found(target, "quarterly").length, 1);
});

test("restoring into the same database after changing state brings the saved state back", async (t) => {
	const db = await database(t);
	seedAccountData(db);
	seedModuleState(db);
	const document = await exportDocument(db);

	db.db.exec(`
		UPDATE module_settings SET enabled = 1 WHERE module_id = 'templates';
		UPDATE module_settings SET enabled = 0 WHERE module_id = 'import';
		DELETE FROM user_module_access;
		DELETE FROM booking_appointments;
		UPDATE calendar_events SET title = 'Renamed' WHERE id = 'event-1';
	`);
	seedBookingAppointment(db);
	db.db.exec("UPDATE booking_appointments SET created_at = 99");
	await restoreDatabaseRecords(db, encode(document));

	assert.deepEqual((await exportDocument(db)).tables, document.tables);
	assert.deepEqual(await listEnabledModules(uncached(db), MEMBER), ["import"]);
	assert.deepEqual(found(db, "renamed"), []);
	assert.deepEqual(found(db, "cafe"), ["event-1"]);
});
