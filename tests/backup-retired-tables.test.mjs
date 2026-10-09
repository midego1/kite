import assert from "node:assert/strict";
import { cpSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(root, "drizzle/migrations");
const directory = makeBundleDirectory("kite-backup-retired-test-");
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { exportDatabaseRecords, restoreDatabaseRecords } from "./src/lib/backups/export.ts";
		`,
		resolveDir: root,
		sourcefile: "backup-retired-test-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	absWorkingDir: root,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const { SqliteDatabase, applyMigrations, exportDatabaseRecords, restoreDatabaseRecords } = await import(
	pathToFileURL(join(directory, "entry.mjs")).href
);

/** Migrations up to, but not including, the one that drops license_settings. */
const preDropMigrationsDir = join(directory, "migrations-before-0056");
cpSync(migrationsDir, preDropMigrationsDir, {
	recursive: true,
	filter: (source) => !source.endsWith("0056_drop_license_settings.sql"),
});

const REQUIRED_TABLES = [
	"users",
	"domains",
	"mailboxes",
	"mailbox_access",
	"contacts",
	"folders",
	"api_keys",
	"messages",
	"message_attachments",
	"outbound_jobs",
	"routing_rules",
	"webhooks",
	"webhook_deliveries",
	"sessions",
	"audit_logs",
	"backup_settings",
	"backups",
	"app_settings",
];

function legacyBackup({ includedTables } = {}) {
	const tables = Object.fromEntries(REQUIRED_TABLES.map((table) => [table, []]));
	tables.users = [
		{ id: "u1", email: "owner@example.test", password_hash: "hash", name: "Owner", role: "admin", created_at: 1 },
	];
	tables.license_settings = [
		{
			id: "default",
			instance_id: "instance",
			instance_url: null,
			license_key_hash: "abc",
			plan: "team",
			state: "active",
			features: "[]",
			activated_at: 1,
			validated_at: 1,
			updated_at: 1,
		},
	];
	const document = { format: "mailflare-database-backup", version: 1, createdAt: new Date(0).toISOString(), tables };
	if (includedTables) {
		tables.ai_usage = [];
		document.includedTables = [...REQUIRED_TABLES, "ai_usage", "license_settings"];
	}
	return new TextEncoder().encode(JSON.stringify(document)).buffer;
}

async function database(t, dir = migrationsDir) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, dir);
	return db;
}

function hasTable(db, name) {
	return !!db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

for (const includedTables of [false, true]) {
	test(`an old backup with license_settings restores after the table is dropped${includedTables ? " (with includedTables)" : ""}`, async (t) => {
		const db = await database(t);
		assert.equal(hasTable(db, "license_settings"), false);
		await restoreDatabaseRecords(db, legacyBackup({ includedTables }));
		assert.equal(db.db.prepare("SELECT email FROM users WHERE id = 'u1'").get().email, "owner@example.test");
		assert.equal(hasTable(db, "license_settings"), false);
	});
}

test("a database that has not applied 0056 can still be backed up and restored", async (t) => {
	const db = await database(t, preDropMigrationsDir);
	assert.equal(hasTable(db, "license_settings"), true);
	db.db.exec("INSERT INTO license_settings (id, instance_id, updated_at) VALUES ('default', 'instance', 1)");
	const exported = JSON.parse(new TextDecoder().decode(await exportDatabaseRecords(db)));
	assert.equal("license_settings" in exported.tables, false);
	assert.equal(exported.includedTables.includes("license_settings"), false);
	await restoreDatabaseRecords(db, legacyBackup({ includedTables: true }));
	assert.equal(db.db.prepare("SELECT count(*) AS count FROM users").get().count, 1);
});
