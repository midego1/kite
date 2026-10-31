import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

// The reader's moves in conversation view send `conversation: true`, so reporting the open message takes the rest
// of its conversation in that folder along instead of leaving it, and the conversation's row, in the Inbox.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-bulk-conversation-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		bulk: fileURLToPath(import.meta.resolve("../src/app/api/messages/bulk/utils.ts")),
		bulkRoute: fileURLToPath(import.meta.resolve("../src/app/api/messages/bulk/route.ts")),
		session: fileURLToPath(import.meta.resolve("../src/lib/auth/session.ts")),
		runtime: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	splitting: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	packages: "external",
	tsconfig: join(root, "tsconfig.json"),
	alias: {
		"cloudflare:workers": join(root, "server/runtime/cloudflare-workers.ts"),
		"next/headers": "next/headers.js",
		"next/server": "next/server.js",
	},
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { conversationScopes, isConversationBulkAction } = await load("bulk");
const { POST: bulkMessages } = await load("bulkRoute");
const { createSession } = await load("session");
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");

test("conversationScopes lists each conversation once, per folder, and never widens drafts or unthreaded mail", () => {
	const row = (overrides) => ({ mailboxId: "m1", threadId: "t1", status: "received", folderId: null, ...overrides });
	assert.deepEqual(conversationScopes([row(), row()]), [
		{ mailboxId: "m1", threadId: "t1", status: "received", folderId: null },
	]);
	assert.deepEqual(
		conversationScopes([row(), row({ status: "archived" }), row({ folderId: "f1" }), row({ mailboxId: "m2" })]).length,
		4,
	);
	assert.deepEqual(
		conversationScopes([row({ status: "draft" }), row({ threadId: null }), row({ mailboxId: null })]),
		[],
	);
});

test("only moves out of a folder take the conversation along", () => {
	for (const action of ["archive", "trash", "spam", "phishing", "inbox", "folder"])
		assert.equal(isConversationBulkAction(action), true, action);
	for (const action of ["read", "unread", "delete", "restore"])
		assert.equal(isConversationBulkAction(action), false, action);
});

const owner = { id: "owner" };
let count = 0;

async function setup(t) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, join(root, "drizzle/migrations"));
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Owner', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'a', 1);
		INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('folder-1', 'owner', 'mailbox-a', 'Bills', 1);
	`);
	const env = { DB: db };
	globalThis.__kiteNodeEnv = env;
	t.after(() => delete globalThis.__kiteNodeEnv);
	const addMessage = ({ threadId = "thread-1", status = "received", direction = "inbound", folderId = null } = {}) => {
		const id = `msg-${++count}`;
		db.db
			.prepare(
				"INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, thread_id, folder_id, created_at) VALUES (?, 'owner', 'mailbox-a', ?, 'deals@promo.test', 'a@example.com', 'Limited offer', 'Buy now.', ?, ?, ?, ?)",
			)
			.run(id, direction, status, threadId, folderId, count);
		return id;
	};
	const statusOf = (id) => db.db.prepare("SELECT status FROM messages WHERE id = ?").get(id).status;
	return { env, addMessage, statusOf };
}

async function bulk(env, body) {
	const token = await createSession(env, owner.id);
	const response = await bulkMessages(
		new Request("https://kite.test/api/messages/bulk", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
	return { status: response.status, json: await response.json() };
}

test("a spam report with conversation reports every message of the conversation in the same folder", async (t) => {
	const { env, addMessage, statusOf } = await setup(t);
	const first = addMessage();
	const open = addMessage();
	const sent = addMessage({ status: "sent", direction: "outbound" });
	const archived = addMessage({ status: "archived" });
	const inFolder = addMessage({ folderId: "folder-1" });
	const otherThread = addMessage({ threadId: "thread-2" });

	const { status, json } = await bulk(env, { action: "spam", messageIds: [open], conversation: true });
	assert.equal(status, 200);
	assert.deepEqual(json.undo.map((state) => state.id).sort(), [first, open].sort());
	assert.ok(json.undo.every((state) => state.status === "received" && state.receiptId));
	assert.equal(statusOf(first), "spam");
	assert.equal(statusOf(open), "spam");
	// The rest of the thread is elsewhere (Sent, Archived, a folder), and another thread is not touched.
	assert.equal(statusOf(sent), "sent");
	assert.equal(statusOf(archived), "archived");
	assert.equal(statusOf(inFolder), "received");
	assert.equal(statusOf(otherThread), "received");

	// Undo puts both back.
	await bulk(env, { action: "restore", restore: json.undo });
	assert.equal(statusOf(first), "received");
	assert.equal(statusOf(open), "received");
});

test("without conversation a spam report moves only the given message, as before", async (t) => {
	const { env, addMessage, statusOf } = await setup(t);
	const first = addMessage();
	const open = addMessage();
	await bulk(env, { action: "spam", messageIds: [open] });
	assert.equal(statusOf(open), "spam");
	assert.equal(statusOf(first), "received");
});

test("conversation is ignored for read state, and archive takes the folder's conversation along", async (t) => {
	const { env, addMessage, statusOf } = await setup(t);
	const first = addMessage();
	const open = addMessage();
	await bulk(env, { action: "read", messageIds: [open], conversation: true });
	const read = (id) => env.DB.db.prepare("SELECT read FROM messages WHERE id = ?").get(id).read;
	assert.equal(read(open), 1);
	assert.equal(read(first), 0);

	const { json } = await bulk(env, { action: "archive", messageIds: [open], conversation: true });
	assert.equal(json.undo.length, 2);
	assert.equal(statusOf(first), "archived");
	assert.equal(statusOf(open), "archived");
});
