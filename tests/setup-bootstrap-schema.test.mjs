import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(root, "drizzle/migrations");
const directory = makeBundleDirectory("kite-bootstrap-schema-test-");
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
		`,
		resolveDir: root,
		sourcefile: "bootstrap-schema-test-entry.ts",
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
const { SqliteDatabase, applyMigrations } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

function tableNames(database) {
	return database.db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
		.all()
		.map((row) => row.name);
}

test("every journal entry has a migration file, so a fresh database applies them all", async (t) => {
	const journal = JSON.parse(readFileSync(join(migrationsDir, "meta/_journal.json"), "utf8"));
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	const applied = await applyMigrations(database, migrationsDir);
	for (const entry of journal.entries) assert.ok(applied.includes(`${entry.tag}.sql`), `${entry.tag} was not applied`);
});

test("a fresh database has no license table and accepts mailbox and auto-reply inserts", async (t) => {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, migrationsDir);
	assert.ok(!tableNames(database).includes("license_settings"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('u', 'a@b.c', 'x', 'n', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d', 'u', 'ex.com', 'z', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, display_name, signature, auto_reply_enabled, auto_reply_subject, auto_reply_body, created_at)
			VALUES ('m', 'u', 'd', 'admin', 'admin', 'sig', 0, 'Out of office', '', 1);
		INSERT INTO auto_reply_deliveries (id, mailbox_id, recipient, sent_at) VALUES ('ar', 'm', 'x@y.z', 1);
	`);
	assert.equal(database.db.prepare("SELECT count(*) AS count FROM mailboxes").get().count, 1);
});
