import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { bundleModules } from "./support/modules-bundle.mjs";
import {
	copyMigrationsBefore,
	migrationsDir,
	seedAccountData,
	seedBookingAppointment,
} from "./support/module-database.mjs";

const {
	SqliteDatabase,
	applyMigrations,
	assertBackupTablesCoverDatabase,
	exportDatabaseRecords,
	listApplicationTables,
	BACKUP_TABLE_GROUPS,
} = await bundleModules("kite-module-migration-", [
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
	["assertBackupTablesCoverDatabase, exportDatabaseRecords, listApplicationTables", "src/lib/backups/export.ts"],
	["BACKUP_TABLE_GROUPS", "src/lib/backups/table-groups.ts"],
]);

const scratch = makeBundleDirectory("kite-module-migration-dirs-");
after(() => rmSync(scratch, { recursive: true, force: true }));
const preDirectory = copyMigrationsBefore(scratch, 62);
const MIGRATION = "0062_add_module_platform.sql";
/** Migrations after 0062, in order. */
const LATER_MIGRATIONS = [
	"0063_add_finance_module.sql",
	"0064_add_drive.sql",
	"0065_add_storage_stores.sql",
	"0066_add_domain_dns_skipped.sql",
	"0067_add_screener.sql",
	"0068_add_abuse_ch_auth_key.sql",
	"0069_add_ai_writing.sql",
	"0070_add_writing_style.sql",
	"0071_add_telemetry_state.sql",
	"0072_add_ai_summaries.sql",
	"0073_add_spam_report_receipts.sql",
	"0074_add_message_html_body_key.sql",
	"0075_add_telemetry_notice.sql",
	"0076_add_import_job_folders.sql",
	"0077_add_agent_providers.sql",
	"0078_add_ai_usage_details.sql",
	"0079_add_external_accounts.sql",
	"0080_add_user_preferences.sql",
	"0081_add_backup_objects.sql",
	"0082_external_account_address_scope.sql",
	"0083_add_external_account_send_state.sql",
	"0084_add_spam_strict_dmarc.sql",
	"0085_add_direct_uploads_state.sql",
	"0086_add_folder_color_is_custom.sql",
	"0087_add_audit_logs_action_index.sql",
	"0089_add_external_identities.sql",
];
/** Columns a later migration adds to a table this test pins; everything else must stay as it was. */
const LATER_COLUMNS = {
	messages: ["html_body_key", "body_size", "external_account_id"],
	users: ["can_connect_accounts"],
};
/** The modules 0062 seeds a row for; later modules have no row, which means `defaultEnabled`. */
const MODULES = ["calendar", "booking", "templates", "import"];

async function database(t, dir = migrationsDir) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, dir);
	return db;
}

async function databaseWithOwner(t) {
	const db = await database(t);
	db.db.exec(
		"INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('owner', 'o@example.com', 'hash', 'Owner', 1)",
	);
	return db;
}

const names = (db, query) =>
	db.db
		.prepare(query)
		.all()
		.map((row) => row.name);
const columns = (db, table) => names(db, `PRAGMA table_info(${table})`);

/** Calendar event ids whose indexed text matches `term`, found the way the search handler will. */
function matches(db, term) {
	return db.db
		.prepare(
			"SELECT id FROM calendar_events WHERE rowid IN (SELECT rowid FROM calendar_events_fts WHERE calendar_events_fts MATCH ?) ORDER BY id",
		)
		.all(term)
		.map((row) => row.id);
}

function insertEvent(db, id, fields = {}) {
	const event = { title: "Untitled", description: "", location: "", attendees: "[]", ...fields };
	db.db
		.prepare(
			"INSERT INTO calendar_events (id, user_id, title, description, location, attendees, starts_at, ends_at, created_at, updated_at) VALUES (?, 'owner', ?, ?, ?, ?, 1, 2, 1, 1)",
		)
		.run(id, event.title, event.description, event.location, event.attendees);
}

function assertIndexIntact(db) {
	// FTS5 compares the index with the content table and throws when they differ.
	db.db.prepare("INSERT INTO calendar_events_fts(calendar_events_fts) VALUES ('integrity-check')").run();
}

test("the journal lists 0062_add_module_platform at idx 65, then 0063_add_finance_module, and the files exist", () => {
	const journal = JSON.parse(readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8"));
	const entry = journal.entries.find((item) => item.tag === "0062_add_module_platform");
	assert.deepEqual(entry, {
		idx: 65,
		version: "6",
		when: 1788851220028,
		tag: "0062_add_module_platform",
		breakpoints: true,
	});
	const next = journal.entries[journal.entries.indexOf(entry) + 1];
	assert.deepEqual(next, {
		idx: 66,
		version: "6",
		when: 1788851280028,
		tag: "0063_add_finance_module",
		breakpoints: true,
	});
	for (const file of [MIGRATION, ...LATER_MIGRATIONS]) assert.ok(readdirSync(migrationsDir).includes(file), file);
});

test("a fresh database gets the module tables and four enabled module rows", async (t) => {
	const db = await database(t);
	assert.deepEqual(
		db.db.prepare("SELECT id, module_id, enabled, updated_by FROM module_settings ORDER BY rowid").all(),
		MODULES.map((id) => ({ id, module_id: id, enabled: 1, updated_by: null })),
	);
	for (const table of ["user_module_access", "booking_appointments"])
		assert.equal(db.db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, 0, table);
	assert.ok(names(db, "SELECT name FROM sqlite_master WHERE type = 'table'").includes("calendar_events_fts"));
	assert.deepEqual(
		names(
			db,
			"SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'calendar_events_fts_%' ORDER BY name",
		),
		["calendar_events_fts_ad", "calendar_events_fts_ai", "calendar_events_fts_au"],
	);
	assert.equal(db.db.prepare("SELECT count(*) AS count FROM d1_migrations WHERE name = ?").get(MIGRATION).count, 1);
});

test("the module tables are unique per module and per user and module, and cascade as designed", async (t) => {
	const db = await database(t);
	seedAccountData(db);
	assert.throws(
		() =>
			db.db.exec("INSERT INTO module_settings (id, module_id, enabled, updated_at) VALUES ('dup', 'calendar', 0, 1)"),
		/UNIQUE constraint failed/,
	);
	db.db.exec(
		"INSERT INTO user_module_access (id, user_id, module_id, allowed, updated_at) VALUES ('a1', 'member', 'calendar', 0, 1)",
	);
	assert.throws(
		() =>
			db.db.exec(
				"INSERT INTO user_module_access (id, user_id, module_id, allowed, updated_at) VALUES ('a2', 'member', 'calendar', 1, 1)",
			),
		/UNIQUE constraint failed/,
	);
	assert.equal(db.db.prepare("SELECT allowed FROM user_module_access WHERE id = 'a1'").get().allowed, 0);

	db.db.exec("UPDATE module_settings SET updated_by = 'member' WHERE module_id = 'import'");
	seedBookingAppointment(db);
	db.db.exec("DELETE FROM booking_events WHERE id = 'type-1'");
	assert.equal(
		db.db.prepare("SELECT booking_event_id FROM booking_appointments").get().booking_event_id,
		null,
		"deleting the event type keeps the appointment",
	);
	db.db.exec("DELETE FROM calendar_events WHERE id = 'event-2'");
	assert.equal(db.db.prepare("SELECT count(*) AS count FROM booking_appointments").get().count, 0);
	db.db.exec("DELETE FROM users WHERE id = 'member'");
	assert.equal(db.db.prepare("SELECT count(*) AS count FROM user_module_access").get().count, 0);
	assert.equal(
		db.db.prepare("SELECT updated_by FROM module_settings WHERE module_id = 'import'").get().updated_by,
		null,
	);
});

test("upgrading from 0061 changes no existing table beyond later columns and indexes the events that already exist", async (t) => {
	const db = await database(t, preDirectory);
	assert.equal(
		names(db, "SELECT name FROM sqlite_master WHERE name = 'module_settings' OR name LIKE 'calendar_events_fts%'")
			.length,
		0,
	);
	seedAccountData(db);
	const before = Object.fromEntries(
		["calendar_events", "booking_events", "messages", "users"].map((table) => [table, columns(db, table)]),
	);
	assert.deepEqual(await applyMigrations(db, migrationsDir), [MIGRATION, ...LATER_MIGRATIONS]);

	for (const [table, expected] of Object.entries(before))
		assert.deepEqual(columns(db, table), [...expected, ...(LATER_COLUMNS[table] ?? [])], table);
	assert.deepEqual(names(db, "SELECT module_id AS name FROM module_settings ORDER BY rowid"), MODULES);
	assert.equal(db.db.prepare("SELECT count(*) AS count FROM module_settings WHERE enabled = 1").get().count, 4);
	assert.equal(db.db.prepare("SELECT count(*) AS count FROM calendar_events").get().count, 2);
	// `rebuild` filled the index for rows that were there before the triggers existed; the accent is folded.
	assert.deepEqual(matches(db, "cafe"), ["event-1"]);
	assert.deepEqual(matches(db, "video"), ["event-2"]);
	assert.deepEqual(matches(db, "ana"), ["event-1"]);
	assertIndexIntact(db);
});

test("the insert trigger indexes title, description, location and attendees", async (t) => {
	const db = await databaseWithOwner(t);
	insertEvent(db, "e1", {
		title: "Budget",
		description: "Quarterly planning",
		location: "Lisbon office",
		attendees: '["rui@example.com"]',
	});
	for (const term of ["budget", "planning", "lisbon", "rui"]) assert.deepEqual(matches(db, term), ["e1"], term);
	assert.deepEqual(matches(db, "nothing"), []);
	assertIndexIntact(db);
});

test("the update trigger re-indexes each indexed column and ignores the others", async (t) => {
	const db = await databaseWithOwner(t);
	insertEvent(db, "e1", {
		title: "Budget",
		description: "Planning",
		location: "Lisbon",
		attendees: '["rui@example.com"]',
	});
	const update = (column, value) =>
		db.db.prepare(`UPDATE calendar_events SET ${column} = ? WHERE id = 'e1'`).run(value);

	update("title", "Retro");
	assert.deepEqual([matches(db, "budget"), matches(db, "retro")], [[], ["e1"]]);
	update("description", "Lessons");
	assert.deepEqual([matches(db, "planning"), matches(db, "lessons")], [[], ["e1"]]);
	update("location", "Porto");
	assert.deepEqual([matches(db, "lisbon"), matches(db, "porto")], [[], ["e1"]]);
	update("attendees", '["sam@example.com"]');
	assert.deepEqual([matches(db, "rui"), matches(db, "sam")], [[], ["e1"]]);
	assertIndexIntact(db);

	update("color", "red");
	update("starts_at", 5);
	assert.deepEqual(matches(db, "retro"), ["e1"]);
	assertIndexIntact(db);
});

test("the delete trigger removes the event from the index", async (t) => {
	const db = await databaseWithOwner(t);
	insertEvent(db, "e1", { title: "Budget" });
	insertEvent(db, "e2", { title: "Budget review" });
	db.db.exec("DELETE FROM calendar_events WHERE id = 'e1'");
	assert.deepEqual(matches(db, "budget"), ["e2"]);
	db.db.exec("DELETE FROM calendar_events");
	assert.deepEqual(matches(db, "budget"), []);
	assertIndexIntact(db);
});

test("rebuild restores an index that was emptied", async (t) => {
	const db = await database(t);
	seedAccountData(db);
	db.db.exec("INSERT INTO calendar_events_fts(calendar_events_fts) VALUES ('delete-all')");
	assert.deepEqual(matches(db, "cafe"), []);
	db.db.exec("INSERT INTO calendar_events_fts(calendar_events_fts) VALUES ('rebuild')");
	assert.deepEqual(matches(db, "cafe"), ["event-1"]);
	assertIndexIntact(db);
});

test("backup lists name the new tables in foreign-key order; 0062 added no group", async (t) => {
	const db = await database(t);
	seedAccountData(db);
	await assertBackupTablesCoverDatabase(db);
	const document = JSON.parse(new TextDecoder().decode(await exportDatabaseRecords(db)));
	const order = Object.keys(document.tables);
	const at = (table) => {
		assert.ok(order.includes(table), `${table} is in BACKUP_TABLES`);
		return order.indexOf(table);
	};

	assert.ok(at("app_settings") < at("module_settings"));
	assert.ok(at("users") < at("user_module_access"));
	assert.ok(at("booking_events") < at("calendar_events"));
	assert.ok(at("calendar_events") < at("booking_appointments"));
	assert.ok(at("booking_events") < at("booking_appointments"));

	assert.deepEqual(
		BACKUP_TABLE_GROUPS.map((group) => group.id),
		["accounts", "mail", "drive", "automation", "assistant", "system"],
	);
	const groupOf = (table) =>
		BACKUP_TABLE_GROUPS.filter((group) => group.tables.includes(table)).map((group) => group.id);
	assert.deepEqual(groupOf("module_settings"), ["system"]);
	assert.deepEqual(groupOf("user_module_access"), ["accounts"]);
	assert.deepEqual(groupOf("booking_appointments"), ["accounts"]);
	assert.deepEqual(groupOf("email_templates"), groupOf("calendar_events"));
	for (const table of order) assert.equal(groupOf(table).length, 1, `${table} is in exactly one group`);
	assert.equal(document.tables.module_settings.length, 4);
});

test("the calendar search index is derived: internal to backups, like the message index", async (t) => {
	const db = await database(t);
	const shadow = names(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'calendar_events_fts%'");
	assert.ok(shadow.includes("calendar_events_fts") && shadow.length > 1, shadow.join());
	const listed = await listApplicationTables(db);
	for (const table of shadow) assert.equal(listed.has(table), false, table);
	assert.equal(listed.has("messages_fts"), false);
	assert.ok(listed.has("module_settings") && listed.has("user_module_access") && listed.has("booking_appointments"));

	// Import jobs stay transient and are not backed up.
	assert.ok(names(db, "SELECT name FROM sqlite_master WHERE type = 'table'").includes("import_jobs"));
	assert.equal(listed.has("import_jobs"), false);
	const document = JSON.parse(new TextDecoder().decode(await exportDatabaseRecords(db)));
	assert.equal("import_jobs" in document.tables, false);
	assert.equal(
		Object.keys(document.tables).some((table) => table.includes("_fts")),
		false,
	);
});

test("a fresh database applies every migration in the repository, 0062 then the later ones last", async (t) => {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	const applied = await applyMigrations(db, migrationsDir);
	assert.deepEqual(applied.slice(-1 - LATER_MIGRATIONS.length), [MIGRATION, ...LATER_MIGRATIONS]);
	assert.equal(applied.length, readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).length);
});
