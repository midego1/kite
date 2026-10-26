import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-agent-chat-actions-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { runEmailTool } from "./src/lib/agent/tools.ts";
			export { confirmAgentAction, undoChatAgentAction } from "./src/lib/agent/actions.ts";
			export { undoAgentAction } from "./src/lib/agent/auto-read/execute.ts";
		`,
		resolveDir: root,
		sourcefile: "agent-chat-actions-entry.ts",
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
	alias: {
		"next/headers": "next/headers.js",
		"cloudflare:workers": "./server/runtime/cloudflare-workers.ts",
	},
	logLevel: "silent",
});
const { SqliteDatabase, applyMigrations, runEmailTool, confirmAgentAction, undoChatAgentAction, undoAgentAction } =
	await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);

const OWNER = { id: "user-1", email: "owner@example.com", role: "user" };
const READER = { id: "user-2", email: "reader@example.com", role: "user" };

async function setup(t) {
	const directory = mkdtempSync(join(tmpdir(), "kite-chat-actions-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const database = new SqliteDatabase(join(directory, "kite.sqlite"));
	t.after(() => database.db.close());
	await applyMigrations(database, join(process.cwd(), "drizzle", "migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('user-1', 'owner@example.com', 'hash', 'Owner', 1);
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('user-2', 'reader@example.com', 'hash', 'Reader', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'user-1', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mailbox-1', 'user-1', 'domain-1', 'team', 'shared', 1);
		INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES ('access-1', 'mailbox-1', 'user-2', 'read_only', 1);
		INSERT INTO folders (id, user_id, mailbox_id, name, color, created_at) VALUES ('fld-bills', 'user-1', 'mailbox-1', 'Bills', '#2563eb', 1);
		INSERT INTO agent_conversations (id, user_id, mailbox_id, title, created_at, updated_at) VALUES ('conv-1', 'user-1', 'mailbox-1', 'Chat', 1, 1);
		INSERT INTO agent_conversations (id, user_id, mailbox_id, title, created_at, updated_at) VALUES ('conv-2', 'user-2', 'mailbox-1', 'Chat', 1, 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-2', 'user-1', 'domain-1', 'private', 1);
		INSERT INTO folders (id, user_id, mailbox_id, name, color, created_at) VALUES ('fld-other', 'user-1', 'mailbox-2', 'Elsewhere', '#2563eb', 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, read, created_at)
		VALUES ('other-1', 'user-1', 'mailbox-2', 'inbound', 'a@example.net', 'private@example.com', 'Private', 'Body', 'received', 0, 5);
	`);
	const insert = database.db.prepare(
		"INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, read, created_at) VALUES (?, 'user-1', 'mailbox-1', 'inbound', 'a@example.net', 'team@example.com', ?, 'Body', ?, ?, ?)",
	);
	insert.run("m1", "Invoice one", "received", 1, 2);
	insert.run("m2", "Invoice two", "archived", 0, 3);
	insert.run("m3", "Held", "screening", 0, 4);
	const env = { DB: database, BUCKET: { get: async () => null, delete: async () => {} } };
	globalThis.__kiteNodeEnv = env;
	t.after(() => delete globalThis.__kiteNodeEnv);
	return { database, env };
}

/** Stores a chat proposal the way the chat stream does, as a tool row of the user's conversation. */
function storeProposal(database, id, conversationId, toolName, proposal) {
	database.db
		.prepare(
			"INSERT INTO agent_chat_messages (id, conversation_id, role, content, tool_name, created_at) VALUES (?, ?, 'tool', ?, ?, 1)",
		)
		.run(id, conversationId, JSON.stringify(proposal), toolName);
}

const message = (database, id) =>
	database.db.prepare("SELECT status, folder_id AS folderId, read FROM messages WHERE id = ?").get(id);
const actionRow = (database, id) => database.db.prepare("SELECT * FROM agent_actions WHERE id = ?").get(id);

test("filing mail into a folder is proposed, approved with an audit row and undone back to where it was", async (t) => {
	const { database, env } = await setup(t);
	const chat = { env, user: OWNER, mailboxId: "mailbox-1", origin: "chat" };
	const listed = await runEmailTool(chat, "list_folders", {});
	assert.deepEqual(
		listed.folders.map((folder) => folder.id),
		["fld-bills"],
	);
	const proposal = await runEmailTool(chat, "move_emails_to_folder", {
		emailIds: ["m1", "m2", "m1"],
		folderId: "fld-bills",
	});
	assert.equal(proposal.status, "pending_approval");
	assert.deepEqual(proposal.emailIds, ["m1", "m2"]);
	assert.equal(proposal.folderName, "Bills");
	assert.equal(message(database, "m1").folderId, null);
	await assert.rejects(
		runEmailTool(chat, "move_emails_to_folder", { emailIds: ["m3"], folderId: "fld-bills" }),
		/not found/,
	);
	await assert.rejects(
		runEmailTool(chat, "move_emails_to_folder", { emailIds: ["m1"], folderId: "fld-nope" }),
		/Folder not found/,
	);

	storeProposal(database, "tool-1", "conv-1", "move_emails_to_folder", proposal);
	const approved = await confirmAgentAction(env, OWNER, "tool-1");
	assert.equal(approved.status, "approved");
	assert.ok(approved.actionId);
	assert.ok(Date.parse(approved.undoUntil) > Date.now() + 6 * 24 * 3600 * 1000);
	assert.deepEqual(message(database, "m1"), { status: "received", folderId: "fld-bills", read: 1 });
	assert.deepEqual(message(database, "m2"), { status: "received", folderId: "fld-bills", read: 0 });
	const audit = actionRow(database, approved.actionId);
	assert.equal(audit.action, "set_folder");
	assert.equal(audit.status, "applied");
	assert.equal(audit.initiator, "user");
	assert.deepEqual(JSON.parse(audit.after), { count: 2, folderId: "fld-bills", folderName: "Bills" });
	assert.equal(database.db.prepare("SELECT count(*) AS n FROM audit_logs WHERE action = 'email.delete'").get().n, 2);
	await assert.rejects(confirmAgentAction(env, OWNER, "tool-1"), /unavailable or already approved/);

	const undone = await undoChatAgentAction(env, OWNER, "tool-1");
	assert.equal(undone.status, "undone");
	assert.deepEqual(message(database, "m1"), { status: "received", folderId: null, read: 1 });
	assert.deepEqual(message(database, "m2"), { status: "archived", folderId: null, read: 0 });
	assert.equal(actionRow(database, approved.actionId).status, "undone");
	assert.equal(
		database.db.prepare("SELECT count(*) AS n FROM agent_actions WHERE variant = ?").get(`undo:${approved.actionId}`).n,
		1,
	);
	await assert.rejects(undoChatAgentAction(env, OWNER, "tool-1"), /cannot be undone/);
});

test("mark unread works with reading access, and its undo restores only what the action changed", async (t) => {
	const { database, env } = await setup(t);
	const chat = { env, user: READER, mailboxId: "mailbox-1", origin: "chat" };
	const proposal = await runEmailTool(chat, "mark_emails_unread", { emailIds: ["m1", "m2"] });
	assert.deepEqual(
		{ action: proposal.action, status: proposal.status, read: proposal.read },
		{ action: "mark_emails_unread", status: "pending_approval", read: false },
	);
	assert.equal(message(database, "m1").read, 1);
	storeProposal(database, "tool-2", "conv-2", "mark_emails_unread", proposal);
	await assert.rejects(confirmAgentAction(env, OWNER, "tool-2"), /Action not found/);
	const approved = await confirmAgentAction(env, READER, "tool-2");
	assert.equal(message(database, "m1").read, 0);
	assert.equal(message(database, "m2").read, 0);
	assert.equal(actionRow(database, approved.actionId).variant, "unread");

	// Moves and folders stay full-access only.
	await assert.rejects(
		runEmailTool(chat, "move_emails", { emailIds: ["m1"], destination: "trash" }),
		/permission denied/,
	);
	await assert.rejects(runEmailTool(chat, "create_folder", { name: "Mine" }), /permission denied/);
	await assert.rejects(
		runEmailTool(chat, "move_emails_to_folder", { emailIds: ["m1"], folderId: "fld-bills" }),
		/permission denied/,
	);

	await undoChatAgentAction(env, READER, "tool-2");
	assert.equal(message(database, "m1").read, 1);
	assert.equal(message(database, "m2").read, 0);
});

test("a folder created in chat can be undone while it is empty, and moves to trash restore their place", async (t) => {
	const { database, env } = await setup(t);
	const chat = { env, user: OWNER, mailboxId: "mailbox-1", origin: "chat" };
	await assert.rejects(
		runEmailTool(chat, "create_folder", { name: "Bills" }),
		/already exists; its folderId is fld-bills/,
	);
	const proposal = await runEmailTool(chat, "create_folder", { name: " Receipts ", color: "green" });
	assert.deepEqual(proposal, { action: "create_folder", status: "pending_approval", name: "Receipts", color: "green" });
	storeProposal(database, "tool-3", "conv-1", "create_folder", proposal);
	const approved = await confirmAgentAction(env, OWNER, "tool-3");
	const folder = database.db.prepare("SELECT id, color, user_id AS userId FROM folders WHERE name = 'Receipts'").get();
	assert.equal(folder.color, "#16a34a");
	assert.equal(folder.userId, "user-1");
	assert.equal(approved.result.folderId, folder.id);
	assert.equal(JSON.parse(actionRow(database, approved.actionId).after).folderId, folder.id);
	const audit = database.db.prepare("SELECT metadata FROM audit_logs WHERE action = 'folder.create'").get();
	assert.equal(JSON.parse(audit.metadata).folderId, folder.id);

	database.db.prepare("UPDATE messages SET folder_id = ? WHERE id = 'm1'").run(folder.id);
	await assert.rejects(undoAgentAction(env, OWNER, approved.actionId), /in use now/);
	assert.equal(actionRow(database, approved.actionId).status, "applied");
	database.db.prepare("UPDATE messages SET folder_id = NULL WHERE id = 'm1'").run();
	await undoChatAgentAction(env, OWNER, "tool-3");
	assert.equal(database.db.prepare("SELECT id FROM folders WHERE id = ?").get(folder.id), undefined);

	const move = await runEmailTool(chat, "move_emails", { emailIds: ["m1", "m2"], destination: "trash" });
	storeProposal(database, "tool-4", "conv-1", "move_emails", move);
	const moved = await confirmAgentAction(env, OWNER, "tool-4");
	assert.equal(message(database, "m1").status, "trash");
	assert.equal(actionRow(database, moved.actionId).variant, "trash");
	// A message moved again since is left alone; the rest go back.
	database.db.prepare("UPDATE messages SET status = 'spam' WHERE id = 'm2'").run();
	const partial = await undoChatAgentAction(env, OWNER, "tool-4");
	assert.equal(message(database, "m1").status, "received");
	assert.equal(message(database, "m2").status, "spam");
	assert.deepEqual(partial.undo, { restored: 1, total: 2 });
	const inverse = database.db
		.prepare("SELECT after FROM agent_actions WHERE variant = ?")
		.get(`undo:${moved.actionId}`);
	assert.deepEqual(
		{ restored: JSON.parse(inverse.after).restored, total: JSON.parse(inverse.after).total },
		{ restored: 1, total: 2 },
	);
});

/** Proposes in chat, stores the proposal and approves it; returns the approved chat result. */
async function approve(database, env, user, conversationId, toolId, name, input) {
	const proposal = await runEmailTool({ env, user, mailboxId: "mailbox-1", origin: "chat" }, name, input);
	storeProposal(database, toolId, conversationId, name, proposal);
	return confirmAgentAction(env, user, toolId);
}

const status = (code) => (error) => error.status === code;

test("undo never overwrites a later change, and refuses with 409 when nothing could go back", async (t) => {
	const { database, env } = await setup(t);
	// Archived, then filed into a folder by someone else: the folder changed, so undo leaves it.
	const moved = await approve(database, env, OWNER, "conv-1", "tool-a", "move_emails", {
		emailIds: ["m1"],
		destination: "archived",
	});
	database.db.prepare("UPDATE messages SET folder_id = 'fld-bills' WHERE id = 'm1'").run();
	await assert.rejects(undoChatAgentAction(env, OWNER, "tool-a"), /moved again since/);
	assert.deepEqual(message(database, "m1"), { status: "archived", folderId: "fld-bills", read: 1 });
	assert.equal(actionRow(database, moved.actionId).status, "applied");

	// Filed, then moved to another folder: still received, but not in the folder the action used.
	database.db.exec(
		"INSERT INTO folders (id, user_id, mailbox_id, name, color, created_at) VALUES ('fld-later', 'user-1', 'mailbox-1', 'Later', '#2563eb', 1)",
	);
	await approve(database, env, OWNER, "conv-1", "tool-b", "move_emails_to_folder", {
		emailIds: ["m2"],
		folderId: "fld-bills",
	});
	database.db.prepare("UPDATE messages SET folder_id = 'fld-later' WHERE id = 'm2'").run();
	await assert.rejects(undoChatAgentAction(env, OWNER, "tool-b"), /moved again since/);
	assert.equal(message(database, "m2").folderId, "fld-later");

	// Marked unread, then read again: nothing to restore is the same 409.
	const marked = await approve(database, env, READER, "conv-2", "tool-c", "mark_emails_unread", { emailIds: ["m1"] });
	database.db.prepare("UPDATE messages SET read = 1 WHERE id = 'm1'").run();
	await assert.rejects(
		undoChatAgentAction(env, READER, "tool-c"),
		(error) => status(409)(error) && /marked again/.test(error.message),
	);
	assert.equal(actionRow(database, marked.actionId).status, "applied");
});

test("undo is refused outside the window and to a reader for someone else's row", async (t) => {
	const { database, env } = await setup(t);
	const filed = await approve(database, env, OWNER, "conv-1", "tool-d", "move_emails_to_folder", {
		emailIds: ["m1"],
		folderId: "fld-bills",
	});
	const ownerRead = await approve(database, env, OWNER, "conv-1", "tool-e", "mark_emails_unread", { emailIds: ["m1"] });
	// A reader cannot tell another user's rows exist, not even read-state ones.
	await assert.rejects(undoAgentAction(env, READER, filed.actionId), status(404));
	await assert.rejects(undoAgentAction(env, READER, ownerRead.actionId), status(404));
	// The chat row belongs to its own user only.
	await assert.rejects(undoChatAgentAction(env, READER, "tool-d"), /Action not found/);

	database.db.prepare("UPDATE agent_actions SET undo_until = 1 WHERE id = ?").run(filed.actionId);
	await assert.rejects(undoChatAgentAction(env, OWNER, "tool-d"), /undo window has passed/);
	assert.equal(message(database, "m1").folderId, "fld-bills");
});

test("another mailbox's emails and folders are refused, also in a tampered proposal", async (t) => {
	const { database, env } = await setup(t);
	const chat = { env, user: OWNER, mailboxId: "mailbox-1", origin: "chat" };
	await assert.rejects(runEmailTool(chat, "mark_emails_read", { emailIds: ["other-1"] }), /not found/i);
	await assert.rejects(
		runEmailTool(chat, "move_emails", { emailIds: ["other-1"], destination: "trash" }),
		/not found/i,
	);
	await assert.rejects(
		runEmailTool(chat, "move_emails_to_folder", { emailIds: ["m1"], folderId: "fld-other" }),
		/Folder not found/,
	);
	assert.deepEqual(
		(await runEmailTool(chat, "list_folders", {})).folders.map((folder) => folder.id),
		["fld-bills"],
	);
	storeProposal(database, "tool-f", "conv-1", "move_emails_to_folder", {
		action: "move_emails_to_folder",
		status: "pending_approval",
		emailIds: ["other-1"],
		folderId: "fld-other",
	});
	await assert.rejects(confirmAgentAction(env, OWNER, "tool-f"), /not found/i);
	assert.deepEqual(message(database, "other-1"), { status: "received", folderId: null, read: 0 });
	assert.equal(
		JSON.parse(database.db.prepare("SELECT content FROM agent_chat_messages WHERE id = 'tool-f'").get().content).status,
		"pending_approval",
	);
});

test("a phishing Mark as spam row has no chat marker and its undo still reopens through restoreMarkedSpam", async (t) => {
	const { database, env } = await setup(t);
	const now = Math.floor(Date.now() / 1000);
	database.db.prepare("UPDATE messages SET status = 'spam' WHERE id = 'm1'").run();
	database.db
		.prepare(
			"INSERT INTO agent_actions (id, mailbox_id, message_id, initiator, acting_user_id, action, variant, status, before, after, reason, undo_until, created_at, updated_at) VALUES ('aact-phish', 'mailbox-1', 'm1', 'user', 'user-1', 'move', 'spam', 'applied', ?, ?, 'user_click', ?, ?, ?)",
		)
		.run(
			JSON.stringify({ status: "received", folderId: "fld-bills" }),
			JSON.stringify({ status: "spam" }),
			now + 3600,
			now,
			now,
		);
	const result = await undoAgentAction(env, OWNER, "aact-phish");
	assert.equal(result.restored, undefined);
	assert.deepEqual(message(database, "m1"), { status: "received", folderId: "fld-bills", read: 1 });
});

test("a folder name taken between the check and the insert answers already exists, without SQL", async (t) => {
	const { database, env } = await setup(t);
	// The trigger plays the other request: it inserts the same name just before Kite's own insert.
	database.db.exec(`
		CREATE TRIGGER race_folder BEFORE INSERT ON folders WHEN NEW.name = 'Race' AND NEW.id != 'fld-race'
		BEGIN INSERT INTO folders (id, user_id, mailbox_id, name, color, created_at) VALUES ('fld-race', NEW.user_id, NEW.mailbox_id, 'Race', NEW.color, 1); END;
	`);
	const mcp = { env, user: OWNER, mailboxId: "mailbox-1", origin: "mcp" };
	await assert.rejects(runEmailTool(mcp, "create_folder", { name: "Race" }), (error) => {
		assert.equal(error.message, 'A folder named "Race" already exists');
		return true;
	});
	database.db.exec("DELETE FROM folders WHERE id = 'fld-race'");
	const proposal = await runEmailTool({ ...mcp, origin: "chat" }, "create_folder", { name: "Race" });
	storeProposal(database, "tool-g", "conv-1", "create_folder", proposal);
	await assert.rejects(confirmAgentAction(env, OWNER, "tool-g"), (error) => {
		assert.equal(error.message, 'A folder named "Race" already exists');
		return true;
	});
	const failed = database.db
		.prepare("SELECT reason FROM agent_actions WHERE action = 'create_folder' AND status = 'failed'")
		.get();
	assert.equal(failed.reason, 'A folder named "Race" already exists');
});
