import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

const { SqliteDatabase, deleteEmptyMailbox } = await bundleModules("kite-empty-mailbox-", [
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["deleteEmptyMailbox", "src/lib/mailboxes/delete.ts"],
]);

test("failed-connection cleanup deletes only empty, unconnected mailboxes, including before connected accounts exist", async () => {
	const DB = new SqliteDatabase(":memory:");
	await DB.exec(
		"CREATE TABLE mailboxes (id TEXT PRIMARY KEY); CREATE TABLE messages (id TEXT PRIMARY KEY, mailbox_id TEXT)",
	);
	const add = (id) => DB.prepare("INSERT INTO mailboxes (id) VALUES (?)").bind(id).run();
	await add("old-schema");
	assert.equal(await deleteEmptyMailbox({ DB }, "old-schema"), true);
	await DB.exec("CREATE TABLE external_accounts (id TEXT PRIMARY KEY, mailbox_id TEXT)");
	await add("mail");
	await DB.prepare("INSERT INTO messages VALUES ('message', 'mail')").run();
	assert.equal(await deleteEmptyMailbox({ DB }, "mail"), false);
	assert.ok(await DB.prepare("SELECT id FROM messages WHERE id = 'message'").first());
	await add("connected");
	await DB.prepare("INSERT INTO external_accounts VALUES ('account', 'connected')").run();
	assert.equal(await deleteEmptyMailbox({ DB }, "connected"), false);
	assert.ok(await DB.prepare("SELECT id FROM external_accounts WHERE id = 'account'").first());
	await add("empty");
	assert.equal(await deleteEmptyMailbox({ DB }, "empty"), true);
	assert.equal(await DB.prepare("SELECT id FROM mailboxes WHERE id = 'empty'").first(), null);
});
