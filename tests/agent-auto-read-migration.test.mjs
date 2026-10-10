import assert from "node:assert/strict";
import { cpSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(root, "drizzle/migrations");
const directory = makeBundleDirectory("kite-agent-auto-read-migration-test-");
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export {
				assertBackupTablesCoverDatabase,
				exportDatabaseRecords,
				restoreDatabaseRecords,
			} from "./src/lib/backups/export.ts";
			export { BACKUP_TABLE_GROUPS } from "./src/lib/backups/table-groups.ts";
		`,
		resolveDir: root,
		sourcefile: "agent-auto-read-migration-test-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	absWorkingDir: root,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const {
	SqliteDatabase,
	applyMigrations,
	assertBackupTablesCoverDatabase,
	exportDatabaseRecords,
	restoreDatabaseRecords,
	BACKUP_TABLE_GROUPS,
} = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const MIGRATION = "0060_add_agent_auto_read.sql";
const NEW_TABLES = ["agent_suggestions", "agent_actions", "agent_sender_policies"];
const DEFAULT_CAPABILITIES = '{"calendar":true,"reply":true,"summary":true,"phishing":true}';

const preMigrationsDir = join(directory, "migrations-before-0060");
cpSync(migrationsDir, preMigrationsDir, { recursive: true, filter: (source) => !source.endsWith(MIGRATION) });

async function database(t, dir = migrationsDir) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, dir);
	return db;
}

function seedMailboxes(db) {
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('user-1', 'owner@example.com', 'hash', 'Owner', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'user-1', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES
			('mailbox-a', 'user-1', 'domain-1', 'a', 1),
			('mailbox-b', 'user-1', 'domain-1', 'b', 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, thread_id, created_at)
		VALUES ('message-1', 'user-1', 'mailbox-a', 'inbound', 'customer@example.net', 'a@example.com', 'Question', 'Hello', 'received', 'thread-1', 2);
		INSERT INTO mailbox_agent_settings (mailbox_id, enabled, auto_draft_enabled, instructions, daily_limit, updated_at) VALUES
			('mailbox-a', 1, 1, 'Be brief', 30, 1),
			('mailbox-b', 1, 0, '', 25, 1);
	`);
}

function seedNewTables(db) {
	db.db.exec(`
		INSERT INTO agent_suggestions (id, mailbox_id, message_id, reviewer_user_id, kind, title, payload, created_at)
		VALUES ('suggestion-1', 'mailbox-a', 'message-1', 'user-1', 'summary', 'Summary', '{"text":"Hi"}', 3);
		INSERT INTO agent_actions (id, mailbox_id, suggestion_id, message_id, initiator, acting_user_id, action, status, created_at, updated_at)
		VALUES ('action-1', 'mailbox-a', 'suggestion-1', 'message-1', 'user', 'user-1', 'dismiss', 'applied', 4, 4);
		INSERT INTO agent_sender_policies (id, mailbox_id, pattern, allowed_actions, created_by_user_id, created_at)
		VALUES ('policy-1', 'mailbox-a', '@example.net', '["send_rsvp"]', 'user-1', 5);
	`);
}

function encode(document) {
	return new TextEncoder().encode(JSON.stringify(document)).buffer;
}

async function exportDocument(db) {
	return JSON.parse(new TextDecoder().decode(await exportDatabaseRecords(db)));
}

test("upgrading from 0059 backfills autonomy from the legacy auto-draft switch", async (t) => {
	const db = await database(t, preMigrationsDir);
	seedMailboxes(db);
	assert.deepEqual(await applyMigrations(db, migrationsDir), [MIGRATION]);

	const rows = db.db
		.prepare(
			"SELECT mailbox_id, autonomy, auto_draft_enabled, capabilities, triage_model_id, auto_read_daily_limit, daily_spend_cap_micros, paused_until, full_auto_hold_minutes FROM mailbox_agent_settings ORDER BY mailbox_id",
		)
		.all();
	const defaults = {
		capabilities: DEFAULT_CAPABILITIES,
		triage_model_id: null,
		auto_read_daily_limit: 200,
		daily_spend_cap_micros: null,
		paused_until: null,
		full_auto_hold_minutes: 10,
	};
	assert.deepEqual(rows, [
		{ mailbox_id: "mailbox-a", autonomy: "suggest", auto_draft_enabled: 1, ...defaults },
		{ mailbox_id: "mailbox-b", autonomy: "off", auto_draft_enabled: 0, ...defaults },
	]);
});

test("0060 adds the install defaults and the new columns", async (t) => {
	const db = await database(t);
	db.db.exec("INSERT OR IGNORE INTO app_settings (id, updated_at) VALUES ('default', 1)");
	assert.deepEqual(
		db.db
			.prepare(
				"SELECT agent_auto_read_enabled, agent_full_auto_allowed, agent_daily_spend_cap_micros, agent_external_auto_read_allowed FROM app_settings",
			)
			.get(),
		{
			agent_auto_read_enabled: 1,
			agent_full_auto_allowed: 0,
			agent_daily_spend_cap_micros: 2_000_000,
			agent_external_auto_read_allowed: 0,
		},
	);
	const columns = (table) =>
		db.db
			.prepare(`PRAGMA table_info(${table})`)
			.all()
			.map((column) => column.name);
	for (const column of ["mailbox_id", "job_id", "reserved"]) assert.ok(columns("ai_usage").includes(column), column);
	for (const column of ["ical_uid", "ical_sequence", "organizer", "source_message_id", "status"])
		assert.ok(columns("calendar_events").includes(column), column);
	const indexes = db.db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
		.all()
		.map((row) => row.name);
	for (const index of [
		"ai_usage_mailbox_created_idx",
		"calendar_events_ical_uid_idx",
		"agent_suggestions_message_kind_idx",
		"agent_suggestions_mailbox_status_idx",
		"agent_actions_mailbox_created_idx",
		"agent_actions_live_idx",
		"agent_sender_policies_pattern_idx",
	])
		assert.ok(indexes.includes(index), index);
});

test("agent_jobs is unique per message and kind", async (t) => {
	const db = await database(t);
	seedMailboxes(db);
	assert.deepEqual(
		db.db
			.prepare("PRAGMA index_info(agent_jobs_source_idx)")
			.all()
			.map((column) => column.name),
		["mailbox_id", "source_message_id", "kind"],
	);
	assert.equal(
		db.db.prepare("SELECT \"unique\" FROM pragma_index_list('agent_jobs') WHERE name = 'agent_jobs_source_idx'").get()
			.unique,
		1,
	);
	const insert = db.db.prepare(
		"INSERT INTO agent_jobs (id, mailbox_id, source_message_id, reviewer_user_id, next_attempt_at, created_at, kind) VALUES (?, 'mailbox-a', 'message-1', 'user-1', 1, 1, ?)",
	);
	db.db
		.prepare(
			"INSERT INTO agent_jobs (id, mailbox_id, source_message_id, reviewer_user_id, next_attempt_at, created_at) VALUES ('job-draft', 'mailbox-a', 'message-1', 'user-1', 1, 1)",
		)
		.run();
	assert.equal(db.db.prepare("SELECT kind FROM agent_jobs WHERE id = 'job-draft'").get().kind, "draft");
	insert.run("job-triage", "triage");
	assert.throws(() => insert.run("job-triage-2", "triage"), /UNIQUE constraint failed/);
});

test("agent_actions allows one live row per suggestion, action and variant", async (t) => {
	const db = await database(t);
	seedMailboxes(db);
	seedNewTables(db);
	const insert = db.db.prepare(
		"INSERT INTO agent_actions (id, mailbox_id, suggestion_id, initiator, action, variant, status, created_at, updated_at) VALUES (?, 'mailbox-a', 'suggestion-1', 'user', 'send_rsvp', ?, ?, 1, 1)",
	);
	insert.run("rsvp-accept", "accepted", "applied");
	insert.run("rsvp-decline", "declined", "pending");
	assert.throws(() => insert.run("rsvp-accept-2", "accepted", "pending"), /UNIQUE constraint failed/);
	db.db.prepare("UPDATE agent_actions SET status = 'undone' WHERE id = 'rsvp-accept'").run();
	insert.run("rsvp-accept-3", "accepted", "applied");
	insert.run("rsvp-failed", "accepted", "failed");
	assert.equal(db.db.prepare("SELECT variant FROM agent_actions WHERE id = 'action-1'").get().variant, "");
});

test("a backup after 0060 covers the new tables in foreign-key order and round-trips", async (t) => {
	const db = await database(t);
	seedMailboxes(db);
	seedNewTables(db);
	await assertBackupTablesCoverDatabase(db);

	const document = await exportDocument(db);
	const order = Object.keys(document.tables);
	for (const table of NEW_TABLES) assert.equal(document.tables[table].length, 1, table);
	assert.ok(order.indexOf("agent_send_approvals") < order.indexOf("agent_suggestions"));
	assert.ok(order.indexOf("agent_suggestions") < order.indexOf("agent_actions"));
	const assistant = BACKUP_TABLE_GROUPS.find((group) => group.id === "assistant").tables;
	for (const table of NEW_TABLES) assert.ok(assistant.includes(table), table);

	const target = await database(t);
	await restoreDatabaseRecords(target, encode(document));
	assert.deepEqual(await exportDocument(target).then((restored) => restored.tables), document.tables);
});

test("a backup taken before 0060 restores into a 0060 database", async (t) => {
	const legacy = await database(t, preMigrationsDir);
	seedMailboxes(legacy);
	const document = await exportDocument(legacy);
	// Code from before 0060 did not know these tables, so its documents omit them entirely.
	for (const table of NEW_TABLES) {
		assert.deepEqual(document.tables[table] ?? [], [], table);
		delete document.tables[table];
	}
	document.includedTables = document.includedTables?.filter((table) => !NEW_TABLES.includes(table));
	assert.equal("autonomy" in document.tables.mailbox_agent_settings[0], false);

	const db = await database(t);
	seedMailboxes(db);
	seedNewTables(db);
	await restoreDatabaseRecords(db, encode(document));

	assert.equal(db.db.prepare("SELECT count(*) AS count FROM messages").get().count, 1);
	assert.deepEqual(
		db.db
			.prepare(
				"SELECT mailbox_id, auto_draft_enabled, instructions, daily_limit, autonomy, auto_read_daily_limit, capabilities FROM mailbox_agent_settings ORDER BY mailbox_id",
			)
			.all(),
		[
			{
				mailbox_id: "mailbox-a",
				auto_draft_enabled: 1,
				instructions: "Be brief",
				daily_limit: 30,
				autonomy: "off",
				auto_read_daily_limit: 200,
				capabilities: DEFAULT_CAPABILITIES,
			},
			{
				mailbox_id: "mailbox-b",
				auto_draft_enabled: 0,
				instructions: "",
				daily_limit: 25,
				autonomy: "off",
				auto_read_daily_limit: 200,
				capabilities: DEFAULT_CAPABILITIES,
			},
		],
	);
	for (const table of NEW_TABLES)
		assert.equal(db.db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, 0, table);
});
