import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-folder-color-bundle-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createDb } from "./src/db/index.ts";
			export { folders } from "./src/db/schema/index.ts";
			export { selectRows } from "./src/lib/db/pending-columns.ts";
			export { insertFolder } from "./src/lib/folders/insert.ts";
			export { folderSchema } from "./src/lib/validators.ts";
			export { isPickedFolderColor } from "./src/lib/folders/colors.ts";
		`,
		resolveDir: root,
		sourcefile: "folder-color-entry.ts",
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
	alias: { "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});
const kite = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);

async function database(t, { migrated }) {
	const directory = mkdtempSync(join(tmpdir(), "kite-folder-color-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const database = new kite.SqliteDatabase(join(directory, "kite.sqlite"));
	t.after(() => database.db.close());
	await kite.applyMigrations(database, join(root, "drizzle", "migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('user-1', 'owner@example.test', 'hash', 'Owner', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('dom-1', 'user-1', 'example.test', 'manual', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mbx-1', 'user-1', 'dom-1', 'me', 1);
	`);
	if (!migrated) database.db.exec("ALTER TABLE folders DROP COLUMN color_is_custom");
	return kite.createDb(database);
}

const base = { userId: "user-1", mailboxId: "mbx-1" };

test("a picked colour is stored as custom, a folder without one is not, and a picked blue is told apart", async (t) => {
	const db = await database(t, { migrated: true });
	await kite.insertFolder(db, { ...base, id: "f-default", name: "Default" });
	await kite.insertFolder(db, { ...base, id: "f-blue", name: "Blue", color: "#2563eb", colorIsCustom: true });
	await kite.insertFolder(db, { ...base, id: "f-red", name: "Red", color: "#dc2626", colorIsCustom: true });
	const rows = Object.fromEntries((await kite.selectRows(db, kite.folders)).map((row) => [row.id, row]));
	assert.deepEqual([rows["f-default"].color, rows["f-default"].colorIsCustom], ["#2563eb", false]);
	assert.deepEqual([rows["f-blue"].color, rows["f-blue"].colorIsCustom], ["#2563eb", true]);
	assert.deepEqual([rows["f-red"].color, rows["f-red"].colorIsCustom], ["#dc2626", true]);
});

test("migration 0086 leaves existing folders as not picked", async (t) => {
	const db = await database(t, { migrated: false });
	await kite.insertFolder(db, { ...base, id: "f-old", name: "Old", color: "#dc2626" });
	db.run(readFileSync(join(root, "drizzle", "migrations", "0086_add_folder_color_is_custom.sql"), "utf8"));
	const [row] = await kite.selectRows(db, kite.folders);
	assert.deepEqual([row.id, row.color, row.colorIsCustom], ["f-old", "#dc2626", false]);
});

test("before migration 0086 folders still read and a picked colour still saves, as not picked", async (t) => {
	const db = await database(t, { migrated: false });
	await kite.insertFolder(db, { ...base, id: "f-red", name: "Red", color: "#dc2626", colorIsCustom: true });
	await kite.insertFolder(db, { ...base, id: "f-default", name: "Default" });
	const rows = await kite.selectRows(db, kite.folders);
	assert.equal(rows.length, 2);
	for (const row of rows) assert.equal(row.colorIsCustom, false);
	assert.equal(rows.find((row) => row.id === "f-red").color, "#dc2626");
});

test("the create request marks a colour as picked only when it is sent", () => {
	assert.equal(kite.folderSchema.parse({ mailboxId: "m", name: "A" }).color, undefined);
	assert.equal(kite.folderSchema.parse({ mailboxId: "m", name: "A", color: "#2563eb" }).color, "#2563eb");
	assert.equal(kite.folderSchema.safeParse({ mailboxId: "m", name: "A", color: "red" }).success, false);
});

test("the rail shows a picked colour, including the default blue, and nothing otherwise", () => {
	assert.equal(kite.isPickedFolderColor("#2563eb", true), true);
	assert.equal(kite.isPickedFolderColor("#dc2626", true), true);
	assert.equal(kite.isPickedFolderColor("#2563eb", false), false);
	assert.equal(kite.isPickedFolderColor("#2563EB"), false);
	// Coloured before the flag existed: still picked.
	assert.equal(kite.isPickedFolderColor("#dc2626", false), true);
});
