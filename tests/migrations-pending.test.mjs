import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { readMigrationBundle } from "../scripts/migration-bundle-utils.mjs";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-migrations-pending-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export * from "./src/lib/migrations/pending.ts";
			export * from "./src/lib/migrations/auto-apply.ts";
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
		`,
		resolveDir: root,
		sourcefile: "migrations-pending-entry.ts",
	},
	outfile: join(bundleDirectory, "entry.mjs"),
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
const { SqliteDatabase, getPendingMigrationStatus, maybeAutoApplyPendingMigrations, queueRetryDelaySeconds } =
	await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);

const bundled = readMigrationBundle(join(root, "drizzle", "migrations")).map((migration) => migration.name);

/** A database connection that fails every read, as a broken deployment binding would. */
function brokenDatabase() {
	return {
		reads: 0,
		prepare() {
			this.reads += 1;
			throw new Error("database unavailable");
		},
	};
}

/** True when nothing in the database has been applied yet. */
function isEmptyDatabase(database) {
	return database.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master").get().count === 0;
}

test("the status counts unapplied migrations and sends names only when asked", async () => {
	const database = new SqliteDatabase(":memory:");
	try {
		assert.deepEqual(await getPendingMigrationStatus(database), { pending: bundled.length });
		assert.deepEqual(await getPendingMigrationStatus(database, { includeNames: true }), {
			pending: bundled.length,
			names: bundled,
		});
		await database
			.prepare(
				"CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP)",
			)
			.run();
		for (const name of bundled) await database.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(name).run();
		assert.deepEqual(await getPendingMigrationStatus(database, { includeNames: true }), { pending: 0 });
	} finally {
		database.db.close();
	}
});

test("other admins are told which account can apply the migrations", async () => {
	const database = new SqliteDatabase(":memory:");
	try {
		// No users table yet: the status still answers, without a name.
		assert.deepEqual(await getPendingMigrationStatus(database, { includeApplier: true }), { pending: bundled.length });
		await database
			.prepare(
				"CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, name TEXT, role TEXT, is_primary_admin INTEGER, disabled INTEGER, created_at INTEGER)",
			)
			.run();
		const insert = "INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?)";
		await database.prepare(insert).bind("u1", "member@example.com", "Member", "user", 0, 0, 1).run();
		await database.prepare(insert).bind("u2", "gone@example.com", "Gone", "admin", 1, 1, 2).run();
		await database.prepare(insert).bind("u3", "owner@example.com", "Owner", "admin", 1, 0, 3).run();
		assert.deepEqual(await getPendingMigrationStatus(database, { includeApplier: true }), {
			pending: bundled.length,
			appliedBy: { name: "Owner", email: "owner@example.com" },
		});
		// Without the option the primary admin is never named.
		assert.deepEqual(await getPendingMigrationStatus(database), { pending: bundled.length });
	} finally {
		database.db.close();
	}
});

test("a database it cannot read reads as nothing pending and keeps the usual retry", async () => {
	const database = brokenDatabase();
	assert.deepEqual(await getPendingMigrationStatus(database), { pending: 0 });
	assert.equal(await queueRetryDelaySeconds(database), 10);
});

test("a failed queue message waits longer while a migration is pending", async () => {
	const database = new SqliteDatabase(":memory:");
	try {
		assert.equal(await queueRetryDelaySeconds(database), 60);
		// A caller that already waits longer keeps its own delay.
		assert.equal(await queueRetryDelaySeconds(database, 90), 90);
	} finally {
		database.db.close();
	}
});

test("an unset or unrecognized auto-apply switch leaves the database alone", async () => {
	for (const value of [undefined, "", "0", "yes", "false"]) {
		const database = new SqliteDatabase(":memory:");
		try {
			await maybeAutoApplyPendingMigrations({ DB: database, AUTO_APPLY_MIGRATIONS: value });
			assert.equal((await getPendingMigrationStatus(database)).pending, bundled.length, `applied for ${value}`);
			assert.equal(isEmptyDatabase(database), true, `touched the database for ${value}`);
		} finally {
			database.db.close();
		}
	}
});

test("a failed run is retried by the next check", async () => {
	const database = brokenDatabase();
	const env = { DB: database, AUTO_APPLY_MIGRATIONS: " 1 " };
	// The run fails and is logged; the next check tries again rather than staying silent.
	await maybeAutoApplyPendingMigrations(env);
	const afterFirst = database.reads;
	assert.ok(afterFirst > 0);
	await maybeAutoApplyPendingMigrations(env);
	assert.ok(database.reads > afterFirst);
});

test("auto-apply applies every pending migration once per instance", async () => {
	const database = new SqliteDatabase(":memory:");
	try {
		const env = { DB: database, AUTO_APPLY_MIGRATIONS: "TRUE" };
		await maybeAutoApplyPendingMigrations(env);
		assert.equal((await getPendingMigrationStatus(database)).pending, 0);

		// A later check in the same instance leaves the database alone, even with work pending.
		await database.prepare("DELETE FROM d1_migrations WHERE name = ?").bind(bundled[0]).run();
		assert.equal((await getPendingMigrationStatus(database)).pending, 1);
		await maybeAutoApplyPendingMigrations(env);
		assert.equal((await getPendingMigrationStatus(database)).pending, 1);
	} finally {
		database.db.close();
	}
});
