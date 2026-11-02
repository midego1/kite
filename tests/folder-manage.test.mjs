import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-folder-manage-bundle-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createDb } from "./src/db/index.ts";
			export { folders, messages, routingRules } from "./src/db/schema/index.ts";
			export { selectRows } from "./src/lib/db/pending-columns.ts";
			export { insertFolder } from "./src/lib/folders/insert.ts";
			export { deleteFolder, folderNameTaken, getFolderUsage, isUniqueNameError, updateFolder } from "./src/lib/folders/manage.ts";
			export { FOLDER_MOVE_BATCH_SIZE, folderDeleteSummary } from "./src/lib/folders/manage-utils.ts";
			export { folderDeleteSchema, folderUpdateSchema } from "./src/lib/validators.ts";
		`,
		resolveDir: root,
		sourcefile: "folder-manage-entry.ts",
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
const { eq } = await import("drizzle-orm");

async function database(t) {
	const directory = mkdtempSync(join(tmpdir(), "kite-folder-manage-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const database = new kite.SqliteDatabase(join(directory, "kite.sqlite"));
	t.after(() => database.db.close());
	await kite.applyMigrations(database, join(root, "drizzle", "migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('user-1', 'owner@example.test', 'hash', 'Owner', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('dom-1', 'user-1', 'example.test', 'manual', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mbx-1', 'user-1', 'dom-1', 'me', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mbx-2', 'user-1', 'dom-1', 'other', 1);
	`);
	return { db: kite.createDb(database), raw: database.db };
}

const base = { userId: "user-1", mailboxId: "mbx-1" };

function addMessages(raw, folderId, count, { status = "received", mailboxId = "mbx-1", prefix = "m" } = {}) {
	const insert = raw.prepare(
		`INSERT INTO messages (id, user_id, mailbox_id, direction, folder_id, from_addr, to_addr, status, created_at)
		 VALUES (?, 'user-1', ?, 'inbound', ?, 'a@x.test', 'me@example.test', ?, 1)`,
	);
	for (let index = 0; index < count; index++) insert.run(`${prefix}-${index}`, mailboxId, folderId, status);
}

function message(raw, id) {
	return raw.prepare("SELECT status, folder_id AS folderId FROM messages WHERE id = ?").get(id);
}

test("deleting a folder with archive moves every message, in batches, and then removes the folder", async (t) => {
	const { db, raw } = await database(t);
	await kite.insertFolder(db, { ...base, id: "f-1", name: "Notes" });
	const total = kite.FOLDER_MOVE_BATCH_SIZE * 2 + 37;
	addMessages(raw, "f-1", total);
	assert.equal((await kite.getFolderUsage(db, "f-1", "mbx-1")).messageCount, total);

	const outcome = await kite.deleteFolder(db, "f-1", "mbx-1", "archive");
	assert.deepEqual(outcome, { ok: true, messagesMoved: total, rulesDisabled: 0 });
	assert.equal(
		raw.prepare("SELECT count(*) AS n FROM messages WHERE status = 'archived' AND folder_id IS NULL").get().n,
		total,
	);
	assert.equal(raw.prepare("SELECT count(*) AS n FROM folders").get().n, 0);
});

test("moving to the inbox keeps the status, and archive only touches mail still in the inbox state", async (t) => {
	const { db, raw } = await database(t);
	await kite.insertFolder(db, { ...base, id: "f-inbox", name: "To inbox" });
	await kite.insertFolder(db, { ...base, id: "f-archive", name: "To archive" });
	addMessages(raw, "f-inbox", 2, { prefix: "in" });
	addMessages(raw, "f-archive", 1, { prefix: "ar" });
	addMessages(raw, "f-archive", 1, { prefix: "tr", status: "trash" });
	addMessages(raw, "f-archive", 1, { prefix: "sp", status: "spam" });

	await kite.deleteFolder(db, "f-inbox", "mbx-1", "inbox");
	assert.deepEqual(message(raw, "in-0"), { status: "received", folderId: null });

	await kite.deleteFolder(db, "f-archive", "mbx-1", "archive");
	assert.deepEqual(message(raw, "ar-0"), { status: "archived", folderId: null });
	// A trashed message is not pulled out of Trash by archiving, only out of the folder.
	assert.deepEqual(message(raw, "tr-0"), { status: "trash", folderId: null });
	assert.deepEqual(message(raw, "sp-0"), { status: "spam", folderId: null });
});

test("a folder with mail is not deleted without a destination, and an empty one needs none", async (t) => {
	const { db, raw } = await database(t);
	await kite.insertFolder(db, { ...base, id: "f-full", name: "Full" });
	await kite.insertFolder(db, { ...base, id: "f-empty", name: "Empty" });
	addMessages(raw, "f-full", 2);

	const refused = await kite.deleteFolder(db, "f-full", "mbx-1", undefined);
	assert.equal(refused.ok, false);
	assert.equal(refused.reason, "move_required");
	assert.equal(refused.usage.messageCount, 2);
	assert.deepEqual(message(raw, "m-0"), { status: "received", folderId: "f-full" });

	assert.deepEqual(await kite.deleteFolder(db, "f-empty", "mbx-1", undefined), {
		ok: true,
		messagesMoved: 0,
		rulesDisabled: 0,
	});
});

test("mail of another mailbox filed under the same folder id is left alone", async (t) => {
	const { db, raw } = await database(t);
	await kite.insertFolder(db, { ...base, id: "f-1", name: "Notes" });
	addMessages(raw, "f-1", 1, { prefix: "mine" });
	addMessages(raw, "f-1", 1, { prefix: "theirs", mailboxId: "mbx-2" });
	await kite.deleteFolder(db, "f-1", "mbx-1", "archive");
	assert.deepEqual(message(raw, "mine-0"), { status: "archived", folderId: null });
	// The foreign key clears the other row's folder when the folder goes; its status is not touched.
	assert.deepEqual(message(raw, "theirs-0"), { status: "received", folderId: null });
});

test("inbox rules filing into the folder are turned off and counted", async (t) => {
	const { db, raw } = await database(t);
	await kite.insertFolder(db, { ...base, id: "f-1", name: "Notes" });
	raw.exec(`
		INSERT INTO routing_rules (id, user_id, domain_id, scope, pattern, match_value, action, mailbox_id, folder_id, enabled, created_at)
		VALUES ('r-on', 'user-1', 'dom-1', 'mailbox', 'x', 'x', 'store', 'mbx-1', 'f-1', 1, 1),
		       ('r-off', 'user-1', 'dom-1', 'mailbox', 'y', 'y', 'store', 'mbx-1', 'f-1', 0, 1),
		       ('r-spam', 'user-1', 'dom-1', 'mailbox', 'z', 'z', 'spam', 'mbx-1', NULL, 1, 1);
	`);
	const usage = await kite.getFolderUsage(db, "f-1", "mbx-1");
	assert.equal(usage.ruleCount, 2);

	const outcome = await kite.deleteFolder(db, "f-1", "mbx-1", undefined);
	assert.equal(outcome.ok, true);
	assert.equal(outcome.rulesDisabled, 1);
	const rules = Object.fromEntries(
		raw
			.prepare("SELECT id, enabled FROM routing_rules")
			.all()
			.map((row) => [row.id, row.enabled]),
	);
	assert.deepEqual(rules, { "r-on": 0, "r-off": 0, "r-spam": 1 });
});

test("an import still filing into the folder blocks the delete until it ends", async (t) => {
	const { db, raw } = await database(t);
	await kite.insertFolder(db, { ...base, id: "f-1", name: "Notes" });
	raw.exec(`
		INSERT INTO import_jobs (id, user_id, mailbox_id, label, destination, host, port, username, folder, status, created_at, updated_at)
		VALUES ('job-1', 'user-1', 'mbx-1', 'Old mail', 'folder:f-1', 'imap.test', 993, 'u', 'INBOX', 'running', 1, 1);
	`);
	const blocked = await kite.deleteFolder(db, "f-1", "mbx-1", undefined);
	assert.equal(blocked.ok, false);
	assert.equal(blocked.reason, "import_active");
	raw.exec("UPDATE import_jobs SET status = 'completed'");
	assert.equal((await kite.deleteFolder(db, "f-1", "mbx-1", undefined)).ok, true);
});

test("renaming and recolouring: a colour marks the folder as picked, a name alone does not", async (t) => {
	const { db } = await database(t);
	await kite.insertFolder(db, { ...base, id: "f-1", name: "Notes" });
	await kite.insertFolder(db, { ...base, id: "f-2", name: "Receipts" });
	const read = async (id) => (await kite.selectRows(db, kite.folders, eq(kite.folders.id, id)))[0];

	await kite.updateFolder(db, "f-1", "mbx-1", { name: "Journal" });
	assert.deepEqual([(await read("f-1")).name, (await read("f-1")).colorIsCustom], ["Journal", false]);

	await kite.updateFolder(db, "f-1", "mbx-1", { color: "#2563eb" });
	assert.deepEqual([(await read("f-1")).color, (await read("f-1")).colorIsCustom], ["#2563eb", true]);

	assert.equal(await kite.folderNameTaken(db, "mbx-1", "Receipts", "f-1"), true);
	assert.equal(await kite.folderNameTaken(db, "mbx-1", "Receipts", "f-2"), false);
	assert.equal(await kite.folderNameTaken(db, "mbx-2", "Receipts", "f-1"), false);
	await assert.rejects(kite.updateFolder(db, "f-1", "mbx-1", { name: "Receipts" }), (error) =>
		kite.isUniqueNameError(error),
	);
});

test("renaming works before migration 0086, keeping the colour as not picked", async (t) => {
	const { db, raw } = await database(t);
	await kite.insertFolder(db, { ...base, id: "f-1", name: "Notes" });
	raw.exec("ALTER TABLE folders DROP COLUMN color_is_custom");
	await kite.updateFolder(db, "f-1", "mbx-1", { name: "Journal", color: "#dc2626" });
	const [row] = await kite.selectRows(db, kite.folders);
	assert.deepEqual([row.name, row.color, row.colorIsCustom], ["Journal", "#dc2626", false]);
});

test("the requests accept only a name or a palette colour, and a move to inbox or archive", () => {
	assert.equal(kite.folderUpdateSchema.safeParse({}).success, false);
	assert.equal(kite.folderUpdateSchema.safeParse({ name: "   " }).success, false);
	assert.equal(kite.folderUpdateSchema.safeParse({ name: "x".repeat(81) }).success, false);
	assert.equal(kite.folderUpdateSchema.safeParse({ color: "red" }).success, false);
	assert.equal(kite.folderUpdateSchema.parse({ name: "  Journal " }).name, "Journal");
	assert.equal(kite.folderUpdateSchema.safeParse({ color: "#16a34a" }).success, true);
	assert.equal(kite.folderDeleteSchema.safeParse({}).success, true);
	assert.equal(kite.folderDeleteSchema.parse({ moveTo: "archive" }).moveTo, "archive");
	assert.equal(kite.folderDeleteSchema.safeParse({ moveTo: "trash" }).success, false);
});

test("the delete summary names the messages and the rules", () => {
	assert.equal(kite.folderDeleteSummary({ messageCount: 0, ruleCount: 0 }), "It holds no messages.");
	assert.equal(kite.folderDeleteSummary({ messageCount: 1, ruleCount: 0 }), "1 message.");
	assert.equal(kite.folderDeleteSummary({ messageCount: 2, ruleCount: 0 }), "2 messages.");
	assert.equal(kite.folderDeleteSummary({ messageCount: 1200, ruleCount: 0 }), "1,200 messages.");
	assert.equal(
		kite.folderDeleteSummary({ messageCount: 2, ruleCount: 1 }),
		"2 messages. 1 inbox rule files mail into this folder; it will be turned off.",
	);
	assert.equal(
		kite.folderDeleteSummary({ messageCount: 0, ruleCount: 3 }),
		"It holds no messages. 3 inbox rules file mail into this folder; they will be turned off.",
	);
});
