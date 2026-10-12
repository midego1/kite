import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

const { SqliteDatabase, migrateCleanDatabase } = await bundleModules("kite-setup-fresh-modules-", [
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["migrateCleanDatabase", "src/lib/setup/migration.ts"],
]);

test("setup migrates an empty database and starts with every module enabled", async (t) => {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());

	assert.equal(await migrateCleanDatabase(db), true);

	const migrations = db.db.prepare("SELECT name FROM d1_migrations WHERE name = ?").all("0062_add_module_platform.sql");
	assert.equal(migrations.length, 1);

	const rows = db.db.prepare("SELECT module_id, enabled FROM module_settings ORDER BY module_id").all();
	assert.deepEqual(
		rows.map((row) => row.module_id),
		["booking", "calendar", "import", "templates"],
	);
	assert.ok(rows.every((row) => row.enabled === 1));
});
