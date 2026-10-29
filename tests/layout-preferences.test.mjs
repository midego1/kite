import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test, { after } from "node:test";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { copyMigrationsBefore, migrationsDir } from "./support/module-database.mjs";
import { bundleModules } from "./support/modules-bundle.mjs";

const {
	SqliteDatabase,
	applyMigrations,
	createDb,
	LayoutPreferencesPendingError,
	readLayoutPreferences,
	saveLayoutPreferences,
	parseLayoutPatch,
	parseLayoutPreferences,
	parseStoredLayout,
	layoutStorageEntries,
	withoutKeys,
} = await bundleModules("kite-layout-preferences-", [
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
	["createDb", "src/db/index.ts"],
	["LayoutPreferencesPendingError, readLayoutPreferences, saveLayoutPreferences", "src/lib/preferences/layout.ts"],
	["parseLayoutPatch, parseLayoutPreferences, parseStoredLayout", "src/lib/preferences/layout-utils.ts"],
	["layoutStorageEntries, withoutKeys", "src/components/layout-preferences-utils.ts"],
]);

const scratch = makeBundleDirectory("kite-layout-preferences-dirs-");
after(() => rmSync(scratch, { recursive: true, force: true }));
const preDirectory = copyMigrationsBefore(scratch, 80);

async function database(t, dir = migrationsDir) {
	const sqlite = new SqliteDatabase(":memory:");
	t.after(() => sqlite.db.close());
	await applyMigrations(sqlite, dir);
	sqlite.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES
			('owner', 'owner@example.com', 'hash', 'Owner', 1),
			('member', 'member@example.com', 'hash', 'Member', 1);
	`);
	return { sqlite, db: createDb(sqlite) };
}

test("parseLayoutPreferences keeps only valid choices and clamps sizes", () => {
	assert.deepEqual(
		parseLayoutPreferences({
			readingPane: "below",
			density: "compact",
			conversationView: false,
			listWidth: 480.6,
			listHeight: 5000,
			sidebar: "wide",
		}),
		{ readingPane: "below", density: "compact", conversationView: false, listWidth: 481, listHeight: 1200 },
	);
	assert.deepEqual(
		parseLayoutPreferences({ readingPane: "left", density: 3, conversationView: "off", listWidth: 10 }),
		{
			listWidth: 250,
		},
	);
	assert.deepEqual(parseLayoutPreferences({ listWidth: Number.NaN, listHeight: "300" }), {});
	for (const value of [null, "x", [], 4]) assert.deepEqual(parseLayoutPreferences(value), {});
});

test("parseStoredLayout reads JSON text and anything else as empty", () => {
	assert.deepEqual(parseStoredLayout('{"density":"comfortable"}'), { density: "comfortable" });
	assert.deepEqual(parseStoredLayout("not json"), {});
	assert.deepEqual(parseStoredLayout(null), {});
});

test("parseLayoutPatch needs a layout object with at least one valid choice", () => {
	assert.deepEqual(parseLayoutPatch({ layout: { readingPane: "none" } }), { readingPane: "none" });
	assert.equal(parseLayoutPatch({ layout: { readingPane: "sideways" } }), null);
	assert.equal(parseLayoutPatch({ readingPane: "none" }), null);
	assert.equal(parseLayoutPatch(null), null);
});

test("a layout maps to the browser storage the views read", () => {
	const layout = { readingPane: "below", density: "compact", conversationView: false, listWidth: 420, listHeight: 300 };
	const entries = layoutStorageEntries(layout, "user-1");
	assert.deepEqual(entries, [
		["kite-reading-pane", "below"],
		["kite-message-density", "compact"],
		["kite-conversation-view", "off"],
		["kite-column-width:message-list", "420"],
		["kite-column-width:message-list:user-1", "420"],
		["kite-column-width:message-list-height", "300"],
		["kite-column-width:message-list-height:user-1", "300"],
	]);
	assert.deepEqual(layoutStorageEntries({}, "user-1"), []);
});

test("withoutKeys leaves out choices made here and not saved yet", () => {
	assert.deepEqual(withoutKeys({ readingPane: "none", density: "compact" }, { density: "default" }), {
		readingPane: "none",
	});
});

test("an account without a saved layout reads as null, and saving merges choices", async (t) => {
	const { db, sqlite } = await database(t);
	assert.deepEqual(await readLayoutPreferences(db, "owner"), { ready: true, layout: null });

	assert.deepEqual(await saveLayoutPreferences(db, "owner", { readingPane: "below" }), { readingPane: "below" });
	assert.deepEqual(await saveLayoutPreferences(db, "owner", { density: "compact", listWidth: 400 }), {
		readingPane: "below",
		density: "compact",
		listWidth: 400,
	});
	assert.deepEqual(await saveLayoutPreferences(db, "owner", { readingPane: "none" }), {
		readingPane: "none",
		density: "compact",
		listWidth: 400,
	});
	assert.deepEqual(await readLayoutPreferences(db, "owner"), {
		ready: true,
		layout: { readingPane: "none", density: "compact", listWidth: 400 },
	});
	// Each account has its own.
	assert.deepEqual(await readLayoutPreferences(db, "member"), { ready: true, layout: null });

	// Deleting the account deletes its layout.
	sqlite.db.exec("PRAGMA foreign_keys = ON; DELETE FROM users WHERE id = 'owner'");
	assert.deepEqual(sqlite.db.prepare("SELECT count(*) AS n FROM user_preferences").get(), { n: 0 });
});

test("before migration 0080 the layout reads as not ready and saving is refused", async (t) => {
	const { db } = await database(t, preDirectory);
	assert.deepEqual(await readLayoutPreferences(db, "owner"), { ready: false, layout: null });
	await assert.rejects(saveLayoutPreferences(db, "owner", { density: "compact" }), LayoutPreferencesPendingError);
});
