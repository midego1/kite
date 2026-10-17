import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-message-list-unread-test-");
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createSession } from "./src/lib/auth/session.ts";
			export { GET as listMessages } from "./src/app/api/messages/route.ts";
			export { affectsInboxUnreadCount, getInboxUnreadDelta, groupThreadMembers, withReadState } from "./src/lib/messages/thread-unread-utils.ts";
			export { assertNothingSkipped, describePermanentDeleteResult, PartialDeleteError } from "./src/lib/messages/permanent-delete-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "message-list-unread-test-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
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
		"next/server": "next/server.js",
		"cloudflare:workers": "./server/runtime/cloudflare-workers.ts",
	},
	logLevel: "silent",
});
const m = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const DELETE_SKIPPED = "Some messages could not be deleted because they are no longer in Trash or Spam.";
/** How many unread messages an action on one Inbox row flips. */
const flips = (row, readValue) => Math.abs(m.getInboxUnreadDelta([row], readValue, true));
const single = (read, direction = "inbound") => ({ direction, read });
const grouped = (threadUnread, size) => ({
	direction: "inbound",
	read: threadUnread === 0,
	threadUnread,
	threadMessageIds: Array.from({ length: size }, (_, index) => `m${index}`),
});

async function threadFixture(t) {
	const database = new m.SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await m.applyMigrations(database, join(root, "drizzle/migrations"));
	// One conversation spread over three folders: two unread Inbox messages, one
	// unread archived message and a sent reply.
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('owner', 'owner@example.test', 'hash', 'Owner', 'admin', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain', 'owner', 'example.test', 'zone', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('box', 'owner', 'domain', 'owner', 1);
		INSERT INTO messages (id, user_id, mailbox_id, thread_id, direction, from_addr, to_addr, subject, status, read, created_at) VALUES
			('in-1', 'owner', 'box', 'thread', 'inbound', 'sam@partner.test', 'owner@example.test', 'Plan', 'received', 0, 1),
			('in-2', 'owner', 'box', 'thread', 'inbound', 'sam@partner.test', 'owner@example.test', 'Re: Plan', 'received', 0, 2),
			('arch', 'owner', 'box', 'thread', 'inbound', 'sam@partner.test', 'owner@example.test', 'Re: Plan', 'archived', 0, 3),
			('sent', 'owner', 'box', 'thread', 'outbound', 'owner@example.test', 'sam@partner.test', 'Re: Plan', 'sent', 0, 4),
			('lone', 'owner', 'box', NULL, 'inbound', 'kim@partner.test', 'owner@example.test', 'Hello', 'received', 0, 5);
	`);
	const env = { DB: database, KITE_RUNTIME: "node" };
	globalThis.__kiteNodeEnv = env;
	t.after(() => {
		delete globalThis.__kiteNodeEnv;
	});
	const session = await m.createSession(env, "owner");
	return async (query) => {
		const response = await m.listMessages(
			new Request(`https://kite.test/api/messages?group=thread&mailboxId=box&${query}`, {
				headers: { Authorization: `Bearer ${session}` },
			}),
		);
		assert.equal(response.status, 200);
		const body = await response.json();
		return new Map(body.messages.map((row) => [row.threadId ?? row.id, row]));
	};
}

test("a conversation row counts unread messages only among those it stands for in the folder", async (t) => {
	const list = await threadFixture(t);
	const inbox = await list("status=received");
	assert.equal(inbox.get("thread").threadUnread, 2);
	assert.deepEqual(inbox.get("thread").threadMessageIds.sort(), ["in-1", "in-2"]);
	assert.equal(inbox.get("thread").threadCount, 4, "the conversation size still counts every folder");
	assert.equal(inbox.get("lone").threadUnread, 1, "a message without a thread id is its own conversation");
	assert.equal((await list("status=archived")).get("thread").threadUnread, 1);
	assert.equal((await list("status=sent")).get("thread").threadUnread, 0, "a sent reply never makes a row unread");
});

test("groupThreadMembers collects ids and counts only unread inbound messages", () => {
	const threads = m.groupThreadMembers([
		{ id: "a", key: "t", read: false, direction: "inbound" },
		{ id: "b", key: "t", read: true, direction: "inbound" },
		{ id: "c", key: "t", read: false, direction: "outbound" },
		{ id: "d", key: "d", read: false, direction: "inbound" },
	]);
	assert.deepEqual(threads.ids.get("t"), ["a", "b", "c"]);
	assert.equal(threads.unread.get("t"), 1);
	assert.deepEqual(threads.ids.get("d"), ["d"]);
	assert.equal(threads.unread.get("d"), 1);
});

test("a single message flips once, and not at all when it already has the state", () => {
	assert.equal(flips(single(false), true), 1);
	assert.equal(flips(single(true), false), 1);
	assert.equal(flips(single(true), true), 0);
	assert.equal(flips(single(false), false), 0);
	assert.equal(flips(single(false, "outbound"), true), 0);
});

test("a conversation row flips its unread messages when read and its read messages when unread", () => {
	assert.equal(flips(grouped(2, 5), true), 2);
	assert.equal(flips(grouped(0, 5), true), 0);
	assert.equal(flips(grouped(1, 4), false), 3);
	assert.equal(flips(grouped(4, 4), false), 0);
	assert.equal(flips(grouped(9, 4), true), 4, "a stale count never exceeds the row's messages");
	assert.equal(flips({ ...grouped(0, 2), threadUnread: undefined }, false), 2);
});

test("only the Inbox list moves the sidebar Inbox count, by the messages really flipped", () => {
	const rows = [grouped(2, 3), single(false), single(true)];
	assert.equal(m.getInboxUnreadDelta(rows, true, true), -3);
	assert.equal(m.getInboxUnreadDelta(rows, false, true), 2);
	assert.equal(m.getInboxUnreadDelta(rows, true, false), 0);
	assert.equal(m.getInboxUnreadDelta([], true, true), 0);
	assert.equal(m.getInboxUnreadDelta(rows, null, true), 0, "archive, trash and the rest change no read state");
	assert.equal(m.affectsInboxUnreadCount({ folder: "inbox" }), true);
	assert.equal(m.affectsInboxUnreadCount({ folder: "inbox", folderId: "receipts" }), false);
	assert.equal(m.affectsInboxUnreadCount({ folder: "archived", folderId: null }), false);
});

test("marking a conversation row read or unread restyles it at once", () => {
	assert.deepEqual(m.withReadState(grouped(2, 3), true).threadUnread, 0);
	assert.deepEqual(m.withReadState(grouped(0, 3), false).threadUnread, 3);
	assert.deepEqual(m.withReadState(single(false), true), { direction: "inbound", read: true });
});

test("a permanent delete that kept messages is reported, anything else is not", () => {
	assert.doesNotThrow(() => m.assertNothingSkipped("read", { skipped: 2 }));
	assert.doesNotThrow(() => m.assertNothingSkipped("delete", { deleted: 3, skipped: 0 }));
	assert.doesNotThrow(() => m.assertNothingSkipped("delete", null));
	assert.throws(
		() => m.assertNothingSkipped("delete", { deleted: 1, skipped: 2 }),
		(error) => error instanceof m.PartialDeleteError && error.skipped === 2 && error.message === DELETE_SKIPPED,
	);
});

test("the bulk delete toast says when messages were kept", () => {
	assert.deepEqual(m.describePermanentDeleteResult(1, 0), { ok: true, message: "1 message deleted forever" });
	assert.deepEqual(m.describePermanentDeleteResult(3, 0), { ok: true, message: "3 messages deleted forever" });
	assert.deepEqual(m.describePermanentDeleteResult(1, 1), {
		ok: false,
		message: `1 message deleted forever. ${DELETE_SKIPPED}`,
	});
	assert.deepEqual(m.describePermanentDeleteResult(0, 2), { ok: false, message: DELETE_SKIPPED });
});
