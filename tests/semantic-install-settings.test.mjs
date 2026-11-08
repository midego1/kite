import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test, { after } from "node:test";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { migrationsDir } from "./support/module-database.mjs";
import { bundleModules } from "./support/modules-bundle.mjs";

const { SqliteDatabase, applyMigrations, saveSemanticAdminSettings, getSemanticInstallSettings } = await bundleModules(
	"kite-semantic-install-settings-",
	[
		["SqliteDatabase", "server/runtime/sqlite-database.ts"],
		["applyMigrations", "server/runtime/migrate.ts"],
		["saveSemanticAdminSettings, getSemanticInstallSettings", "src/lib/semantic/install-settings.ts"],
	],
);

const scratch = makeBundleDirectory("kite-semantic-install-settings-dirs-");
after(() => rmSync(scratch, { recursive: true, force: true }));

async function database(t) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, migrationsDir);
	return db;
}

test("saveSemanticAdminSettings succeeds when the app_settings row already exists (migration 0012 seeds it)", async (t) => {
	const db = await database(t);
	const env = { DB: db };
	await saveSemanticAdminSettings(env, { enabled: true, backfillCapShare: 25 });
	const settings = await getSemanticInstallSettings(env);
	assert.equal(settings.enabled, true);
	assert.equal(settings.backfillCapShare, 25);
});

test("saveSemanticAdminSettings succeeds and creates the row when app_settings has none yet", async (t) => {
	const db = await database(t);
	db.db.exec("DELETE FROM app_settings WHERE id = 'default'");
	assert.equal(db.db.prepare("SELECT count(*) AS total FROM app_settings").get().total, 0);
	const env = { DB: db };
	await saveSemanticAdminSettings(env, { enabled: true });
	const settings = await getSemanticInstallSettings(env);
	assert.equal(settings.enabled, true);
	assert.equal(db.db.prepare("SELECT count(*) AS total FROM app_settings").get().total, 1);
});
