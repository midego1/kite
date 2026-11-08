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
} = await bundleModules("kite-backup-assistant-email-", [
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
	["assertBackupTablesCoverDatabase, exportDatabaseRecords, restoreDatabaseRecords", "src/lib/backups/export.ts"],
]);

const scratch = makeBundleDirectory("kite-backup-assistant-email-dirs-");
after(() => rmSync(scratch, { recursive: true, force: true }));
const preDirectory = copyMigrationsBefore(scratch, 96);
const preAttemptsDirectory = copyMigrationsBefore(scratch, 97);
const ASSISTANT_TABLES = ["assistant_addresses", "assistant_sender_addresses", "assistant_email_requests"];

async function database(t, dir = migrationsDir) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, dir);
	return db;
}

const encode = (document) => new TextEncoder().encode(JSON.stringify(document)).buffer;
const exportDocument = async (db) => JSON.parse(new TextDecoder().decode(await exportDatabaseRecords(db)));
const all = (db, sql) => db.db.prepare(sql).all();

test("a backup taken before 0096 restores after it, with the assistant off and no assistant rows", async (t) => {
	const legacy = await database(t, preDirectory);
	seedAccountData(legacy);
	legacy.db.exec("INSERT INTO user_ai_settings (user_id, instructions, updated_at) VALUES ('owner', 'Be brief.', 1)");
	const document = await exportDocument(legacy);
	// Code from before 0096 did not know the assistant tables or columns, so its documents omit them entirely.
	for (const table of ASSISTANT_TABLES) delete document.tables[table];
	document.includedTables = document.includedTables?.filter((table) => !ASSISTANT_TABLES.includes(table));
	assert.equal("assistant_email_enabled" in document.tables.user_ai_settings[0], false);

	const db = await database(t);
	seedAccountData(db);
	await restoreDatabaseRecords(db, encode(document));

	for (const table of ASSISTANT_TABLES)
		assert.deepEqual(all(db, `SELECT count(*) AS n FROM ${table}`), [{ n: 0 }], table);
	assert.deepEqual(
		all(db, "SELECT instructions, assistant_email_enabled, assistant_email_daily_limit FROM user_ai_settings"),
		[{ instructions: "Be brief.", assistant_email_enabled: 0, assistant_email_daily_limit: 20 }],
	);
	await assertBackupTablesCoverDatabase(db);
});

test("a backup taken before 0097 (security review's attempts column) restores after it, reading attempts as 0", async (t) => {
	const legacy = await database(t, preAttemptsDirectory);
	seedAccountData(legacy);
	legacy.db.exec(
		"INSERT INTO assistant_sender_addresses (id, user_id, address, verified_at, created_at) VALUES ('ase-1', 'owner', 'owner@phone.example', 3, 3)",
	);
	const document = await exportDocument(legacy);
	assert.equal("attempts" in document.tables.assistant_sender_addresses[0], false);

	const db = await database(t);
	seedAccountData(db);
	await restoreDatabaseRecords(db, encode(document));
	assert.deepEqual(all(db, "SELECT address, attempts FROM assistant_sender_addresses"), [
		{ address: "owner@phone.example", attempts: 0 },
	]);
});

test("a backup after 0096 round-trips the assistant address, a verified sender and a request", async (t) => {
	const source = await database(t);
	seedAccountData(source);
	source.db.exec(`
		INSERT INTO user_ai_settings (user_id, assistant_email_enabled, assistant_email_mailbox_id, assistant_email_daily_limit, updated_at)
			VALUES ('owner', 1, 'mailbox-a', 5, 1);
		INSERT INTO assistant_addresses (id, domain_id, local_part, enabled, created_by_user_id, created_at)
			VALUES ('asa-1', 'domain-1', 'assistant', 1, 'owner', 2);
		INSERT INTO assistant_sender_addresses (id, user_id, address, verified_at, created_at)
			VALUES ('ase-1', 'owner', 'owner@phone.example', 3, 3);
		INSERT INTO assistant_email_requests (id, user_id, assistant_address_id, mailbox_id, raw_r2_key, provider_message_id, from_addr, subject, status, created_at)
			VALUES ('aer-1', 'owner', 'asa-1', 'mailbox-a', NULL, '<req-1@example.com>', 'owner@example.com', 'What did Jan say?', 'answered', 4);
	`);
	await assertBackupTablesCoverDatabase(source);
	const document = await exportDocument(source);
	assert.equal(document.tables.assistant_addresses.length, 1);
	assert.equal(document.tables.assistant_sender_addresses.length, 1);
	assert.equal(document.tables.assistant_email_requests.length, 1);
	const order = Object.keys(document.tables);
	assert.ok(order.indexOf("routing_rules") < order.indexOf("assistant_addresses"));
	assert.ok(order.indexOf("agent_conversations") < order.indexOf("assistant_email_requests"));

	const target = await database(t);
	await restoreDatabaseRecords(target, encode(document));
	assert.deepEqual((await exportDocument(target)).tables, document.tables);
	assert.deepEqual(all(target, "SELECT local_part, enabled FROM assistant_addresses"), [
		{ local_part: "assistant", enabled: 1 },
	]);
	assert.deepEqual(all(target, "SELECT status, subject FROM assistant_email_requests"), [
		{ status: "answered", subject: "What did Jan say?" },
	]);
});
