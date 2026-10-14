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
	listEnabledModules,
} = await bundleModules("kite-finance-migration-", [
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
	["assertBackupTablesCoverDatabase, exportDatabaseRecords, restoreDatabaseRecords", "src/lib/backups/export.ts"],
	["BACKUP_TABLE_GROUPS", "src/lib/backups/table-groups.ts"],
	["listEnabledModules", "src/lib/modules/state.ts"],
]);

const scratch = makeBundleDirectory("kite-finance-migration-dirs-");
after(() => rmSync(scratch, { recursive: true, force: true }));
const preDirectory = copyMigrationsBefore(scratch, 63);
const MIGRATION = "0063_add_finance_module.sql";
const TABLES = ["finance_subscriptions", "finance_charges"];

const SUBSCRIPTION_COLUMNS = [
	"id",
	"user_id",
	"mailbox_id",
	"contact_id",
	"vendor",
	"vendor_key",
	"plan",
	"amount_minor",
	"currency",
	"cycle",
	"next_renewal_at",
	"renewal_estimated",
	"trial_ends_at",
	"status",
	"payment_failed_at",
	"reminder_days",
	"calendar_reminder",
	"last_reminded_for",
	"calendar_event_id",
	"cancel_url",
	"cancel_one_click",
	"previous_amount_minor",
	"price_changed_at",
	"source_message_id",
	"last_message_id",
	"created_at",
	"updated_at",
];

const CHARGE_COLUMNS = [
	"id",
	"subscription_id",
	"user_id",
	"message_id",
	"attachment_id",
	"doc_type",
	"amount_minor",
	"currency",
	"document_at",
	"period_start_at",
	"period_end_at",
	"filed_ref",
	"created_at",
];

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
const indexes = (db, table) =>
	all(db, `PRAGMA index_list(${table})`)
		.filter((row) => row.origin === "c")
		.map((row) => ({
			name: row.name,
			unique: row.unique === 1,
			columns: all(db, `PRAGMA index_info(${row.name})`).map((column) => column.name),
		}))
		.sort((a, b) => a.name.localeCompare(b.name));

/** One tracked subscription with two ledger rows: a set and a null attachment, a stated period and none. */
function seedFinance(db) {
	db.db.exec(`
		INSERT INTO finance_subscriptions (id, user_id, mailbox_id, vendor, vendor_key, plan, amount_minor, currency, cycle,
			next_renewal_at, renewal_estimated, trial_ends_at, status, payment_failed_at, reminder_days, calendar_reminder,
			last_reminded_for, calendar_event_id, cancel_url, cancel_one_click, previous_amount_minor, price_changed_at,
			source_message_id, last_message_id, created_at, updated_at)
		VALUES ('sub-1', 'owner', 'mailbox-a', 'Streamly', 'example.net', 'Premium', 1799, 'USD', 'monthly',
			1793404800, 1, NULL, 'active', NULL, 5, 0,
			1790812800, 'event-1', 'https://example.net/unsubscribe', 1, 1599, 1790000000,
			'message-1', 'message-1', 10, 11);
		INSERT INTO finance_charges (id, subscription_id, user_id, message_id, attachment_id, doc_type, amount_minor,
			currency, document_at, period_start_at, period_end_at, filed_ref, created_at)
		VALUES
			('charge-1', 'sub-1', 'owner', 'message-1', 'att-1', 'invoice', 1799, 'USD', 1790812800, 1790812800, 1793404800, NULL, 12),
			('charge-2', 'sub-1', 'owner', 'message-1', NULL, 'refund', 500, 'USD', 1791000000, NULL, NULL, NULL, 13);
	`);
}

test("the journal lists 0063_add_finance_module at idx 66 after 0062", () => {
	const journal = JSON.parse(readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8"));
	const index = journal.entries.findIndex((item) => item.tag === "0063_add_finance_module");
	assert.deepEqual(journal.entries[index], {
		idx: 66,
		version: "6",
		when: 1788851280028,
		tag: "0063_add_finance_module",
		breakpoints: true,
	});
	assert.equal(journal.entries[index - 1].tag, "0062_add_module_platform");
	assert.ok(journal.entries[index].when > journal.entries[index - 1].when);
});

test("0063 creates both tables with every column and index of the spec", async (t) => {
	const db = await database(t);
	assert.deepEqual(columns(db, "finance_subscriptions"), SUBSCRIPTION_COLUMNS);
	assert.deepEqual(columns(db, "finance_charges"), CHARGE_COLUMNS);
	assert.deepEqual(indexes(db, "finance_subscriptions"), [
		{ name: "finance_subscriptions_due_idx", unique: false, columns: ["status", "next_renewal_at"] },
		{ name: "finance_subscriptions_mailbox_idx", unique: false, columns: ["mailbox_id"] },
		{ name: "finance_subscriptions_trial_idx", unique: false, columns: ["status", "trial_ends_at"] },
		{ name: "finance_subscriptions_user_vendor_idx", unique: false, columns: ["user_id", "vendor_key"] },
	]);
	assert.deepEqual(indexes(db, "finance_charges"), [
		{ name: "finance_charges_dedupe_idx", unique: true, columns: ["subscription_id", "message_id", "doc_type"] },
		{ name: "finance_charges_user_idx", unique: false, columns: ["user_id", "document_at"] },
	]);
	const foreignKeys = (table) =>
		all(db, `PRAGMA foreign_key_list(${table})`)
			.map((row) => `${row.from}->${row.table}.${row.to} ${row.on_delete}`)
			.sort();
	assert.deepEqual(foreignKeys("finance_subscriptions"), [
		"calendar_event_id->calendar_events.id SET NULL",
		"contact_id->contacts.id SET NULL",
		"last_message_id->messages.id SET NULL",
		"mailbox_id->mailboxes.id SET NULL",
		"source_message_id->messages.id SET NULL",
		"user_id->users.id CASCADE",
	]);
	assert.deepEqual(foreignKeys("finance_charges"), [
		"message_id->messages.id SET NULL",
		"subscription_id->finance_subscriptions.id CASCADE",
		"user_id->users.id CASCADE",
	]);
});

test("the defaults are active, three reminder days, a calendar reminder and nothing estimated", async (t) => {
	const db = await database(t);
	seedAccountData(db);
	db.db.exec(
		"INSERT INTO finance_subscriptions (id, user_id, vendor, vendor_key, created_at, updated_at) VALUES ('s', 'owner', 'V', 'manual:v', 1, 1)",
	);
	assert.deepEqual(
		db.db
			.prepare(
				"SELECT status, reminder_days, calendar_reminder, renewal_estimated, cancel_one_click FROM finance_subscriptions",
			)
			.get(),
		{ status: "active", reminder_days: 3, calendar_reminder: 1, renewal_estimated: 0, cancel_one_click: 0 },
	);
});

test("one message gives at most one document of each type per subscription, and rows cascade with their parents", async (t) => {
	const db = await database(t);
	seedAccountData(db);
	seedFinance(db);
	assert.throws(
		() =>
			db.db.exec(
				"INSERT INTO finance_charges (id, subscription_id, user_id, message_id, doc_type, amount_minor, currency, document_at, created_at) VALUES ('dup', 'sub-1', 'owner', 'message-1', 'invoice', 1, 'USD', 1, 1)",
			),
		/UNIQUE constraint failed/,
	);
	db.db.exec("PRAGMA foreign_keys = ON");
	db.db.exec("DELETE FROM messages WHERE id = 'message-1'");
	assert.deepEqual(all(db, "SELECT source_message_id, last_message_id FROM finance_subscriptions"), [
		{ source_message_id: null, last_message_id: null },
	]);
	assert.deepEqual(all(db, "SELECT id, message_id, attachment_id FROM finance_charges ORDER BY id"), [
		{ id: "charge-1", message_id: null, attachment_id: "att-1" },
		{ id: "charge-2", message_id: null, attachment_id: null },
	]);
	db.db.exec("DELETE FROM finance_subscriptions WHERE id = 'sub-1'");
	assert.equal(count(db, "finance_charges"), 0);
});

test("0063 inserts no module row: Money Watch is on by default through its manifest", async (t) => {
	const db = await database(t);
	assert.equal(count(db, "module_settings"), 4);
	assert.equal(all(db, "SELECT module_id FROM module_settings WHERE module_id = 'finance'").length, 0);
	const member = { userId: "member", role: "user", isPrimaryAdmin: false };
	assert.ok((await listEnabledModules({ DB: db }, member)).includes("finance"));
});

test("upgrading from 0062 adds only the two tables and changes no existing one", async (t) => {
	const db = await database(t, preDirectory);
	for (const table of TABLES)
		assert.equal(all(db, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${table}'`).length, 0);
	seedAccountData(db);
	const tablesBefore = all(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);
	const before = Object.fromEntries(tablesBefore.map((table) => [table, columns(db, table)]));
	assert.deepEqual(await applyMigrations(db, migrationsDir), [MIGRATION]);
	const tablesAfter = all(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);
	assert.deepEqual(
		tablesAfter.filter((table) => !tablesBefore.includes(table)),
		["finance_charges", "finance_subscriptions"],
	);
	for (const [table, expected] of Object.entries(before)) assert.deepEqual(columns(db, table), expected, table);
});

test("both tables are in BACKUP_TABLES after their parents, in the mail group, exactly once", async (t) => {
	const db = await database(t);
	await assertBackupTablesCoverDatabase(db);
	const order = Object.keys((await exportDocument(db)).tables);
	const at = (table) => {
		assert.ok(order.includes(table), `${table} is backed up`);
		return order.indexOf(table);
	};
	for (const parent of ["users", "mailboxes", "contacts", "messages", "message_attachments", "calendar_events"])
		assert.ok(at(parent) < at("finance_subscriptions"), parent);
	assert.equal(at("finance_subscriptions"), at("booking_appointments") + 1);
	assert.equal(at("finance_charges"), at("finance_subscriptions") + 1);
	const groupOf = (table) =>
		BACKUP_TABLE_GROUPS.filter((group) => group.tables.includes(table)).map((group) => group.id);
	for (const table of TABLES) assert.deepEqual(groupOf(table), ["mail"], table);
	const types = readFileSync(join(migrationsDir, "..", "..", "src/lib/backups/types.d.ts"), "utf8");
	for (const table of TABLES) assert.ok(types.includes(`"${table}"`), `${table} is a DatabaseBackupTable`);
});

test("a backup taken before 0063 restores after 0063 with both tables empty", async (t) => {
	const legacy = await database(t, preDirectory);
	seedAccountData(legacy);
	const document = await exportDocument(legacy);
	// Code from before 0063 did not know these tables, so its documents omit them.
	for (const table of TABLES) {
		assert.deepEqual(document.tables[table] ?? [], [], table);
		delete document.tables[table];
	}
	document.includedTables = document.includedTables?.filter((table) => !TABLES.includes(table));

	const db = await database(t);
	seedAccountData(db);
	seedFinance(db);
	await restoreDatabaseRecords(db, encode(document));
	for (const table of TABLES) assert.equal(count(db, table), 0, table);
	assert.equal(count(db, "messages"), 2);
	assert.equal(count(db, "calendar_events"), 2);
	await assertBackupTablesCoverDatabase(db);
});

test("a backup after 0063 round-trips every subscription and ledger column", async (t) => {
	const source = await database(t);
	seedAccountData(source);
	seedFinance(source);
	await assertBackupTablesCoverDatabase(source);
	const document = await exportDocument(source);
	assert.equal(document.tables.finance_subscriptions.length, 1);
	assert.deepEqual(Object.keys(document.tables.finance_subscriptions[0]), SUBSCRIPTION_COLUMNS);
	assert.deepEqual(Object.keys(document.tables.finance_charges[0]), CHARGE_COLUMNS);

	const target = await database(t);
	await restoreDatabaseRecords(target, encode(document));
	assert.deepEqual((await exportDocument(target)).tables, document.tables);
	assert.deepEqual(
		all(
			target,
			"SELECT id, attachment_id, doc_type, amount_minor, document_at, period_start_at, period_end_at, filed_ref FROM finance_charges ORDER BY id",
		),
		[
			{
				id: "charge-1",
				attachment_id: "att-1",
				doc_type: "invoice",
				amount_minor: 1799,
				document_at: 1790812800,
				period_start_at: 1790812800,
				period_end_at: 1793404800,
				filed_ref: null,
			},
			{
				id: "charge-2",
				attachment_id: null,
				doc_type: "refund",
				amount_minor: 500,
				document_at: 1791000000,
				period_start_at: null,
				period_end_at: null,
				filed_ref: null,
			},
		],
	);
	assert.deepEqual(all(target, "SELECT last_reminded_for, calendar_event_id FROM finance_subscriptions"), [
		{ last_reminded_for: 1790812800, calendar_event_id: "event-1" },
	]);
});

test("restoring Money Watch rows into a database without 0063 asks for the pending migration", async (t) => {
	const source = await database(t);
	seedAccountData(source);
	seedFinance(source);
	const document = await exportDocument(source);

	const legacy = await database(t, preDirectory);
	seedAccountData(legacy);
	await assert.rejects(
		restoreDatabaseRecords(legacy, encode(document)),
		/Apply pending database migrations before restoring finance subscriptions\./,
	);
	assert.equal(count(legacy, "messages"), 2);
});
