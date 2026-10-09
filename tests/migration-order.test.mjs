import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { compareMigrationNames, readMigrationBundle, sortMigrationNames } from "../scripts/migration-bundle-utils.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(root, "drizzle", "migrations");
const files = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql"));
const journal = JSON.parse(readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8"));

// Shipped before the order was pinned. Their file names are their identity in
// d1_migrations, so they keep their shared prefixes; no new pair may join them.
const LEGACY_DUPLICATE_PREFIXES = ["0021", "0047", "0050"];

const directory = mkdtempSync(join(root, "tests", ".tmp-migration-order-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
		`,
		resolveDir: root,
		sourcefile: "migration-order-entry.ts",
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
const { SqliteDatabase, applyMigrations } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

test("every migration file is in the journal exactly once, in apply order", () => {
	const tags = journal.entries.map((entry) => `${entry.tag}.sql`);
	assert.equal(new Set(tags).size, tags.length, "journal lists a migration twice");
	assert.deepEqual([...tags].sort(), [...files].sort(), "journal and drizzle/migrations disagree");
	assert.deepEqual(tags, sortMigrationNames(files), "journal order differs from the apply order");
	assert.deepEqual(
		journal.entries.map((entry) => entry.idx),
		journal.entries.map((_, index) => index),
	);
	for (let index = 1; index < journal.entries.length; index++) {
		assert.ok(
			journal.entries[index].when > journal.entries[index - 1].when,
			`journal timestamps out of order at ${journal.entries[index].tag}`,
		);
	}
});

test("only the legacy migrations share a numeric prefix", () => {
	const byPrefix = new Map();
	for (const name of files) {
		const prefix = name.slice(0, 4);
		byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), name]);
	}
	const duplicated = [...byPrefix]
		.filter(([, names]) => names.length > 1)
		.map(([prefix]) => prefix)
		.sort();
	assert.deepEqual(duplicated, LEGACY_DUPLICATE_PREFIXES);
});

test("the apply order matches Wrangler's: number first, then name", () => {
	assert.deepEqual(sortMigrationNames(["0100_b.sql", "0021_b.sql", "0021_a.sql", "0002_x.sql", "notes.sql"]), [
		"0002_x.sql",
		"0021_a.sql",
		"0021_b.sql",
		"0100_b.sql",
		"notes.sql",
	]);
	assert.ok(compareMigrationNames("0999_z.sql", "1000_a.sql") < 0);
});

test("the Worker bundle and the Node runtime apply the same migrations in the same order", async () => {
	const bundled = readMigrationBundle(migrationsDir).map((migration) => migration.name);
	assert.deepEqual(
		bundled,
		journal.entries.map((entry) => `${entry.tag}.sql`),
	);

	const database = new SqliteDatabase(":memory:");
	try {
		const applied = await applyMigrations(database, migrationsDir);
		assert.deepEqual(applied, bundled);
		const recorded = database.db
			.prepare("SELECT name FROM d1_migrations ORDER BY id")
			.all()
			.map((row) => row.name);
		assert.deepEqual(recorded, bundled);
		assert.deepEqual(await applyMigrations(database, migrationsDir), [], "a second start must not re-apply anything");
	} finally {
		database.db.close();
	}
});
