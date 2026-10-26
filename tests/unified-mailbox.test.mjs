import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-unified-mailbox-test-");
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createSession } from "./src/lib/auth/session.ts";
			export { GET as listMessages } from "./src/app/api/messages/route.ts";
			export { GET as countMessages } from "./src/app/api/messages/counts/route.ts";
			export { GET as navigateMessages } from "./src/app/api/messages/navigation/route.ts";
			export { POST as bulkMessages } from "./src/app/api/messages/bulk/route.ts";
			export { POST as createDraft } from "./src/app/api/drafts/route.ts";
			export { getEmptyFolderConfirmText } from "./src/lib/messages/permanent-delete-utils.ts";
			export { buildMessageCounts } from "./src/app/api/messages/counts/utils.ts";
			export * from "./src/lib/mailboxes/scope-utils.ts";
			export { setMailboxScopeParam } from "./src/hooks/utils.ts";
		`,
		resolveDir: root,
		sourcefile: "unified-mailbox-test-entry.ts",
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

test("the scope is one mailbox, a chosen subset, or every accessible mailbox", () => {
	const accessible = ["a", "b", "shared"];
	assert.deepEqual(m.resolveMailboxScope({}, accessible), { ok: true, ids: accessible });
	assert.deepEqual(m.resolveMailboxScope({ mailboxId: "b" }, accessible), { ok: true, ids: ["b"] });
	assert.deepEqual(m.resolveMailboxScope({ mailboxIds: " a, shared ,a," }, accessible), {
		ok: true,
		ids: ["a", "shared"],
	});
	assert.deepEqual(m.resolveMailboxScope({ mailboxIds: "" }, accessible), { ok: true, ids: accessible });
	assert.deepEqual(m.resolveMailboxScope({ mailboxId: "other" }, accessible), { ok: false });
	assert.deepEqual(
		m.resolveMailboxScope({ mailboxIds: "a,other" }, accessible),
		{ ok: false },
		"one mailbox the user cannot open refuses the whole request",
	);
	assert.deepEqual(m.resolveMailboxScope({ mailboxId: "a", mailboxIds: "other" }, accessible), {
		ok: true,
		ids: ["a"],
	});
});

test("the client sends one id as mailboxId and several as mailboxIds", () => {
	const params = (scope) => {
		const result = new URLSearchParams();
		m.setMailboxScopeParam(result, scope);
		return result.toString();
	};
	assert.equal(params(null), "");
	assert.equal(params("a"), "mailboxId=a");
	assert.equal(params("a,b"), "mailboxIds=a%2Cb");
	assert.equal(m.mailboxIdsParam(["a", "b"], ["a", "b"]), null, "the whole view needs no parameter");
	assert.equal(m.mailboxIdsParam(["a", "b", "c"], ["a", "c"]), "a,c");
});

test("the filter hides mailboxes but never all of them", () => {
	assert.deepEqual(m.visibleMailboxIds(["a", "b", "c"], ["b"]), ["a", "c"]);
	assert.deepEqual(m.visibleMailboxIds(["a", "b"], ["a", "b"]), ["a", "b"]);
	assert.deepEqual(m.visibleMailboxIds(["a", "new"], ["gone"]), ["a", "new"], "a new mailbox shows by default");
});

test("per-message permissions: read-only mail is read and marked read, never moved or deleted", () => {
	const permissions = { own: "full_access", ro: "read_only", sendAs: "send_as" };
	const permissionOf = (id) => permissions[id];
	const items = [
		{ id: "1", mailboxId: "own" },
		{ id: "2", mailboxId: "ro" },
		{ id: "3", mailboxId: "sendAs" },
		{ id: "4", mailboxId: "unknown" },
		{ id: "5", mailboxId: null },
	];
	assert.deepEqual(m.splitByMailboxAccess(items, "archive", permissionOf), { allowed: ["1"], skipped: 4 });
	assert.deepEqual(m.splitByMailboxAccess(items, "trash", permissionOf), { allowed: ["1"], skipped: 4 });
	assert.deepEqual(m.splitByMailboxAccess(items, "read", permissionOf), { allowed: ["1", "2", "3"], skipped: 2 });
	assert.deepEqual(m.splitByMailboxAccess(items, "unread", permissionOf).allowed, ["1", "2", "3"]);
	assert.equal(m.actionNeedsManage("folder"), true);
	assert.equal(m.actionNeedsManage("read"), false);
	assert.equal(m.canManageMailboxMail("full_access"), true);
	assert.equal(m.canManageMailboxMail("send_on_behalf"), false);
	assert.equal(m.canManageMailboxMail(undefined), false);
});

test("folders are offered only for a selection within one mailbox", () => {
	assert.equal(m.singleMailboxOf(["a", "a", null]), "a");
	assert.equal(m.singleMailboxOf(["a", "b"]), null);
	assert.equal(m.singleMailboxOf([]), null);
});

test("counts of several mailboxes add up", () => {
	const counts = m.buildMessageCounts([
		{ mailboxId: "a", folderId: null, direction: "inbound", status: "received", read: false, starred: true, total: 3 },
		{ mailboxId: "b", folderId: null, direction: "inbound", status: "received", read: false, starred: false, total: 2 },
		{ mailboxId: "b", folderId: null, direction: "inbound", status: "received", read: true, starred: false, total: 4 },
		{ mailboxId: "a", folderId: null, direction: "outbound", status: "sent", read: true, starred: false, total: 5 },
		{ mailboxId: "b", folderId: "f", direction: "inbound", status: "received", read: false, starred: false, total: 1 },
	]);
	assert.deepEqual(counts.folders.inbox, { total: 9, unread: 5 });
	assert.deepEqual(counts.folders.starred, { total: 3, unread: 3 });
	assert.deepEqual(counts.folders.sent, { total: 5, unread: 0 });
	assert.deepEqual(counts.customFolders.f, { total: 1, unread: 1 });
	assert.deepEqual(m.sumMailboxCounts(counts.mailboxes, ["a", "b"]), { total: 15, unread: 6, inbox: 9 });
	assert.deepEqual(m.sumMailboxCounts(counts.mailboxes, ["b"]), { total: 7, unread: 3, inbox: 6 });
});

async function fixture(t) {
	const database = new m.SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await m.applyMigrations(database, join(root, "drizzle/migrations"));
	// Owner (an admin) has two mailboxes and read-only access to a shared one; a third user's
	// personal mailbox is never listed, admin or not.
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES
			('owner', 'owner@example.test', 'hash', 'Owner', 'admin', 1),
			('team', 'team@example.test', 'hash', 'Team', 'user', 1),
			('other', 'other@example.test', 'hash', 'Other', 'user', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain', 'owner', 'example.test', 'zone', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES
			('home', 'owner', 'domain', 'owner', 'personal', 1),
			('work', 'owner', 'domain', 'work', 'personal', 1),
			('support', 'team', 'domain', 'support', 'shared', 1),
			('private', 'other', 'domain', 'other', 'personal', 1);
		INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES ('grant', 'support', 'owner', 'read_only', 1);
		INSERT INTO folders (id, user_id, mailbox_id, name, color, created_at) VALUES ('work-folder', 'owner', 'work', 'Receipts', '#000000', 1);
		INSERT INTO messages (id, user_id, mailbox_id, thread_id, direction, from_addr, to_addr, subject, status, read, created_at) VALUES
			('home-1', 'owner', 'home', 'same-thread', 'inbound', 'sam@partner.test', 'owner@example.test', 'Plan', 'received', 0, 1),
			('work-1', 'owner', 'work', 'same-thread', 'inbound', 'sam@partner.test', 'work@example.test', 'Plan', 'received', 0, 2),
			('work-2', 'owner', 'work', NULL, 'inbound', 'kim@partner.test', 'work@example.test', 'Invoice', 'received', 1, 3),
			('support-1', 'team', 'support', NULL, 'inbound', 'lee@partner.test', 'support@example.test', 'Help', 'received', 0, 4),
			('private-1', 'other', 'private', NULL, 'inbound', 'zed@partner.test', 'other@example.test', 'Secret', 'received', 0, 5),
			('held', 'owner', 'home', NULL, 'inbound', 'new@partner.test', 'owner@example.test', 'Hi', 'screening', 0, 6);
		UPDATE messages SET starred = 1 WHERE id IN ('held', 'home-1');
		INSERT INTO folders (id, user_id, mailbox_id, name, color, created_at) VALUES ('private-folder', 'other', 'private', 'Theirs', '#000000', 1);
	`);
	const env = { DB: database, KITE_RUNTIME: "node" };
	globalThis.__kiteNodeEnv = env;
	t.after(() => {
		delete globalThis.__kiteNodeEnv;
	});
	const session = await m.createSession(env, "owner");
	const headers = { Authorization: `Bearer ${session}` };
	const get = async (handler, path) => {
		const response = await handler(new Request(`https://kite.test${path}`, { headers }));
		return { status: response.status, body: await response.json() };
	};
	const bulk = async (payload) => {
		const response = await m.bulkMessages(
			new Request("https://kite.test/api/messages/bulk", {
				method: "POST",
				headers: { ...headers, "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			}),
		);
		return { status: response.status, body: await response.json() };
	};
	const post = async (handler, path, body) => {
		const response = await handler(
			new Request(`https://kite.test${path}`, {
				method: "POST",
				headers: { ...headers, "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}),
		);
		return { status: response.status, body: await response.json() };
	};
	const row = (id) =>
		database.db
			.prepare("SELECT status, folder_id AS folderId, mailbox_id AS mailboxId FROM messages WHERE id = ?")
			.get(id);
	return { get, bulk, post, row, database };
}

const ids = (body) => body.messages.map((message) => message.id).sort();

test("All mailboxes lists every accessible mailbox and nothing else; the filter narrows it", async (t) => {
	const { get } = await fixture(t);
	const inbox = "/api/messages?direction=inbound&status=received";
	const all = await get(m.listMessages, inbox);
	assert.deepEqual(ids(all.body), ["home-1", "support-1", "work-1", "work-2"], "never the other user's or held mail");
	const filtered = await get(m.listMessages, `${inbox}&mailboxIds=home,support`);
	assert.deepEqual(ids(filtered.body), ["home-1", "support-1"]);
	assert.equal((await get(m.listMessages, `${inbox}&mailboxIds=home,private`)).status, 404);
	assert.equal((await get(m.listMessages, `${inbox}&mailboxId=private`)).status, 404, "an admin is no exception");
});

test("conversation view groups a thread per mailbox, never across them", async (t) => {
	const { get } = await fixture(t);
	const grouped = await get(m.listMessages, "/api/messages?direction=inbound&status=received&group=thread");
	const plan = grouped.body.messages.filter((message) => message.threadId === "same-thread");
	assert.deepEqual(plan.map((message) => message.mailboxId).sort(), ["home", "work"]);
	for (const message of plan) {
		assert.deepEqual(message.threadMessageIds, [message.id]);
		assert.equal(message.threadCount, 1, "the other mailbox's copy is not counted");
	}
	const navigation = await get(m.navigateMessages, "/api/messages/navigation?folder=inbox&group=thread");
	assert.equal(navigation.body.messages.length, 4);
	const narrowed = await get(m.navigateMessages, "/api/messages/navigation?folder=inbox&mailboxIds=work,support");
	assert.deepEqual(navigation.status, 200);
	assert.deepEqual(narrowed.body.messages.map((entry) => entry.id).sort(), ["support-1", "work-1", "work-2"]);
});

test("sidebar counts add up the listed mailboxes", async (t) => {
	const { get } = await fixture(t);
	const all = await get(m.countMessages, "/api/messages/counts");
	assert.deepEqual(all.body.counts.folders.inbox, { total: 4, unread: 3 });
	assert.equal(all.body.counts.folders.screener.total, 1);
	const narrowed = await get(m.countMessages, "/api/messages/counts?mailboxIds=work,support");
	assert.deepEqual(narrowed.body.counts.folders.inbox, { total: 3, unread: 2 });
	assert.equal((await get(m.countMessages, "/api/messages/counts?mailboxIds=work,private")).status, 404);
});

test("bulk actions span mailboxes but skip read-only mail and move only within a mailbox", async (t) => {
	const { bulk, row } = await fixture(t);
	const archived = await bulk({ action: "archive", messageIds: ["home-1", "work-1", "support-1"] });
	assert.equal(archived.status, 200);
	assert.equal(row("home-1").status, "archived");
	assert.equal(row("work-1").status, "archived");
	assert.equal(row("support-1").status, "received", "read-only shared mail stays put");
	assert.equal((await bulk({ action: "trash", messageIds: ["support-1"] })).status, 404);
	assert.equal((await bulk({ action: "read", messageIds: ["support-1"] })).status, 200, "but can be marked read");

	const filed = await bulk({ action: "folder", folderId: "work-folder", messageIds: ["work-2", "home-1"] });
	assert.equal(filed.status, 200);
	assert.equal(row("work-2").folderId, "work-folder");
	assert.equal(row("home-1").folderId, null, "mail never moves into another mailbox's folder");
	assert.equal((await bulk({ action: "folder", folderId: "work-folder", messageIds: ["home-1"] })).status, 404);
});

test("a bulk write only touches mail still in the mailbox it was approved in", async (t) => {
	const { bulk, row, database } = await fixture(t);
	// Between the access check and the write, home-1 moves to the read-only shared mailbox.
	const prepare = database.prepare.bind(database);
	let moved = false;
	database.prepare = (sql) => {
		if (!moved && /^update "messages"/i.test(sql)) {
			moved = true;
			database.db.exec("UPDATE messages SET mailbox_id = 'support' WHERE id = 'home-1'");
		}
		return prepare(sql);
	};
	assert.equal((await bulk({ action: "archive", messageIds: ["home-1", "work-1"] })).status, 200);
	assert.equal(row("home-1").status, "received", "the moved message is left alone");
	assert.equal(row("work-1").status, "archived");
});

test("a folder in another user's mailbox is not found, and nothing moves", async (t) => {
	const { bulk, row } = await fixture(t);
	const response = await bulk({ action: "folder", folderId: "private-folder", messageIds: ["home-1", "private-1"] });
	assert.equal(response.status, 404);
	assert.equal(row("home-1").folderId, null);
	assert.equal(row("private-1").folderId, null);
});

test("malformed and oversized mailboxIds never widen the scope", async (t) => {
	const { get } = await fixture(t);
	const inbox = "/api/messages?direction=inbound&status=received";
	assert.deepEqual(ids((await get(m.listMessages, `${inbox}&mailboxIds=${encodeURIComponent(" , ,,")}`)).body), [
		"home-1",
		"support-1",
		"work-1",
		"work-2",
	]);
	const junk = Array.from({ length: 500 }, (_, index) => `mbx_${index}`).join(",");
	for (const route of [m.listMessages, m.countMessages, m.navigateMessages]) {
		const path =
			route === m.navigateMessages ? "/api/messages/navigation?folder=inbox" : "/api/messages?status=received";
		assert.equal((await get(route, `${path}&mailboxIds=${junk}`)).status, 404);
		assert.equal((await get(route, `${path}&mailboxIds=home,'%20OR%201=1`)).status, 404);
		assert.equal((await get(route, `${path}&mailboxIds=home,home,work,`)).status, 200);
	}
});

test("held mail stays out of the counts and navigation outside the Screener", async (t) => {
	const { get } = await fixture(t);
	const { counts } = (await get(m.countMessages, "/api/messages/counts?mailboxIds=home,work")).body;
	assert.deepEqual(counts.folders.starred, { total: 1, unread: 1 }, "the starred held message is not counted");
	assert.equal(counts.folders.inbox.total, 3);
	assert.equal(counts.folders.screener.total, 1);
	const navigation = async (folder) =>
		(await get(m.navigateMessages, `/api/messages/navigation?folder=${folder}&mailboxIds=home,work`)).body.messages.map(
			(entry) => entry.id,
		);
	assert.equal((await navigation("inbox")).includes("held"), false);
	assert.deepEqual(await navigation("starred"), ["home-1"]);
	assert.deepEqual(await navigation("screener"), ["held"]);
});

test("a reply or draft from a read-only shared mailbox is refused", async (t) => {
	const { post } = await fixture(t);
	const draft = await post(m.createDraft, "/api/drafts", {
		mailboxId: "support",
		from: "support@example.test",
		to: "lee@partner.test",
		subject: "Re: Help",
		inReplyTo: "<help@partner.test>",
		text: "Answer",
	});
	assert.equal(draft.status, 403);
	const own = await post(m.createDraft, "/api/drafts", {
		mailboxId: "work",
		from: "work@example.test",
		to: "kim@partner.test",
		subject: "Re: Invoice",
		text: "Answer",
	});
	assert.ok(own.status >= 200 && own.status < 300, "the user's own mailbox can draft the reply");
});

test("every list, count and navigation query stays within D1's 100 bound parameters with 120 mailboxes", async (t) => {
	const { get, database } = await fixture(t);
	const boxes = Array.from({ length: 120 }, (_, index) => `box-${index}`);
	database.db.exec(
		boxes
			.map(
				(id, index) => `
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('${id}', 'owner', 'domain', 'box${index}', 'personal', 1);
		INSERT INTO messages (id, user_id, mailbox_id, thread_id, direction, from_addr, to_addr, subject, status, read, created_at)
			VALUES ('msg-${id}', 'owner', '${id}', 'shared-thread', 'inbound', 'sam@partner.test', 'box${index}@example.test', 'Bulk', 'received', 0, ${10 + index});`,
			)
			.join("\n"),
	);
	const prepare = database.prepare.bind(database);
	let most = 0;
	database.prepare = (sql) => {
		const statement = prepare(sql);
		const bind = statement.bind.bind(statement);
		statement.bind = (...values) => {
			most = Math.max(most, values.length);
			return bind(...values);
		};
		return statement;
	};
	const all = await get(m.listMessages, "/api/messages?direction=inbound&status=received&group=thread&limit=100");
	assert.equal(all.status, 200);
	assert.equal(all.body.total, 124, "one conversation per mailbox, never one across the 120");
	const subset = boxes.slice(0, 110).join(",");
	assert.equal((await get(m.listMessages, `/api/messages?status=received&mailboxIds=${subset}`)).body.total, 110);
	const counts = await get(m.countMessages, `/api/messages/counts?mailboxIds=${subset}`);
	assert.equal(counts.body.counts.folders.inbox.total, 110);
	const navigation = await get(
		m.navigateMessages,
		`/api/messages/navigation?folder=inbox&group=thread&mailboxIds=${subset}`,
	);
	assert.equal(navigation.body.messages.length, 110);
	assert.ok(most <= 100, `a statement bound ${most} parameters`);
});

test("Empty Trash in All mailboxes counts and names only the mailboxes it may empty", () => {
	const plan = m.planEmptyFolder(
		[
			{ id: "home", name: "Home", permission: "full_access" },
			{ id: "desk", name: "Help desk", permission: "read_only" },
			{ id: "work", name: "Work", permission: "full_access" },
			{ id: "empty", name: "Empty", permission: "full_access" },
			{ id: "mine", name: "Mine" },
		],
		(id) => ({ home: 2, desk: 7, work: 1, mine: 3 })[id] ?? 0,
	);
	assert.deepEqual(
		plan.targets.map((target) => target.id),
		["home", "work", "mine"],
	);
	assert.equal(plan.total, 6, "the read-only mailbox's 7 are not counted");
	assert.equal(plan.names, "Home, Work and Mine");
	assert.equal(
		m.getEmptyFolderConfirmText("trash", plan.total, plan.names),
		"Permanently delete all 6 messages in Trash of Home, Work and Mine? This cannot be undone.",
	);
	assert.equal(m.planEmptyFolder([{ id: "a", name: "A" }, { id: "b", name: "B" }], () => 1).names, "A and B");
	assert.equal(m.planEmptyFolder([{ id: "a", name: "A" }], () => 0).names, "");
});

test("the composer offers only mailboxes that can send, and falls back from a From no longer allowed", () => {
	assert.equal(m.canSendFromMailbox("read_only"), false);
	assert.equal(m.canSendFromMailbox("send_on_behalf"), true);
	assert.equal(m.canSendFromMailbox(undefined), true);
	const sendable = [{ id: "home" }, { id: "work" }];
	assert.equal(m.pickComposeMailbox(sendable, ["gone", "work", "home"]).id, "work");
	assert.equal(m.pickComposeMailbox(sendable, [null, "desk"]).id, "home", "a read-only last From falls back");
	assert.equal(m.pickComposeMailbox([], ["home"]), null);
});
