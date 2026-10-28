import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";
import bcrypt from "bcryptjs";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { migrationsDir } from "./support/module-database.mjs";
import { root } from "./support/modules-bundle.mjs";

// Drafts are private to their author (messages.user_id), even in a shared mailbox: every reader answers
// another user's draft as not found, and every list, count and search leaves it out.

const directory = makeBundleDirectory("kite-draft-privacy-");
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { getDb } from "./src/db/index.ts";
			export { createSession } from "./src/lib/auth/session.ts";
			export { GET as getMessage } from "./src/app/api/messages/[messageId]/route.ts";
			export { GET as getMetadata } from "./src/app/api/messages/[messageId]/metadata/route.ts";
			export { GET as getAttachment } from "./src/app/api/messages/[messageId]/attachments/[attachmentId]/route.ts";
			export { GET as getThread } from "./src/app/api/messages/[messageId]/thread/route.ts";
			export { GET as getOriginal } from "./src/app/api/messages/[messageId]/original/route.ts";
			export { POST as postStar } from "./src/app/api/messages/[messageId]/star/route.ts";
			export { POST as postRead } from "./src/app/api/messages/[messageId]/read/route.ts";
			export { POST as postStatus } from "./src/app/api/messages/[messageId]/status/route.ts";
			export { GET as listMessages } from "./src/app/api/messages/route.ts";
			export { GET as getCounts } from "./src/app/api/messages/counts/route.ts";
			export { GET as getNavigation } from "./src/app/api/messages/navigation/route.ts";
			export { POST as postBulk } from "./src/app/api/messages/bulk/route.ts";
			export { POST as postDraft } from "./src/app/api/drafts/route.ts";
			export { GET as getExport } from "./src/app/api/export/messages/route.ts";
			export { GET as getV1Messages } from "./src/app/api/v1/messages/route.ts";
			export { emailGet, emailQuery, emailSet, threadGet, searchSnippetGet } from "./src/lib/jmap/emails.ts";
			export { DELETE as deleteAccess } from "./src/app/api/mailboxes/[id]/access/route.ts";
			export { mailboxGet } from "./src/lib/jmap/mailboxes.ts";
			export { readBlob } from "./src/lib/jmap/blobs.ts";
			export { attachmentBlobId, messageBlobId } from "./src/lib/jmap/ids.ts";
			export { getModuleMessage, readModuleAttachment } from "./src/lib/email/module-read.ts";
			export { canProxyMessageImage } from "./src/lib/remote-images/message-access.ts";
			export { isHiddenDraft, isDraftMoveRefused } from "./src/lib/messages/draft-privacy-utils.ts";
			export { bulkDraftHandling } from "./src/app/api/messages/bulk/utils.ts";
		`,
		resolveDir: root,
		sourcefile: "draft-privacy-test-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	absWorkingDir: root,
	platform: "node",
	format: "esm",
	target: "node22",
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

const ORIGIN = "https://kite.test";
const IMAGE = "https://images.partner.test/logo.png";
const API_KEY = "ep_draftprivacykey";

function memoryBucket() {
	const objects = new Map();
	return {
		objects,
		async get(key) {
			if (!objects.has(key)) return null;
			const bytes = new TextEncoder().encode(objects.get(key));
			return {
				size: bytes.byteLength,
				body: new Response(bytes).body,
				writeHttpMetadata() {},
				text: async () => new TextDecoder().decode(bytes),
				arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
			};
		},
		async head(key) {
			return objects.has(key) ? { size: 1 } : null;
		},
		async put(key, value) {
			objects.set(key, typeof value === "string" ? value : new TextDecoder().decode(value));
		},
		async delete(keys) {
			for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
		},
	};
}

/**
 * Alice owns `shared` and gave Bob and Carol, an administrator, full access. Alice and Bob each wrote a draft
 * there; `mail-1` is ordinary mail everyone reads. Alice's draft has an attachment, an image and the word
 * "zebra" a search would find.
 */
async function fixture(t) {
	const database = new m.SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await m.applyMigrations(database, migrationsDir);
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('alice', 'alice@example.com', 'hash', 'Alice', 'user', 1);
		INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('bob', 'bob@example.com', 'hash', 'Bob', 'user', 1);
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('carol', 'carol@example.com', 'hash', 'Carol', 'admin', 1, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'alice', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('shared', 'alice', 'domain-1', 'team', 'shared', 1);
		INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES ('access-1', 'shared', 'bob', 'full_access', 1);
		INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES ('access-2', 'shared', 'carol', 'full_access', 1);
		INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('folder-1', 'alice', 'shared', 'Projects', 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, snippet, text_body, html_body, status, thread_id, created_at) VALUES
			('mail-1', 'alice', 'shared', 'inbound', 'sam@partner.test', 'team@example.com', 'Hello zebra', 'Hello zebra', 'Hello zebra', NULL, 'received', 'thread-1', 1790000000),
			('draft-alice', 'alice', 'shared', 'outbound', 'team@example.com', 'sam@partner.test', 'Secret plan', 'Confidential zebra', 'Confidential zebra', '<p>Confidential zebra <img src="${IMAGE}"></p>', 'draft', 'thread-1', 1790000100),
			('draft-alice-alone', 'alice', 'shared', 'outbound', 'team@example.com', 'sam@partner.test', 'Unthreaded plan', 'Unthreaded', 'Unthreaded', NULL, 'draft', NULL, 1790000150),
			('draft-bob', 'bob', 'shared', 'outbound', 'team@example.com', 'sam@partner.test', 'Bob notes', 'Bob notes', 'Bob notes', NULL, 'draft', NULL, 1790000200);
		INSERT INTO message_attachments (id, message_id, filename, content_type, size, disposition, r2_key, created_at) VALUES
			('att-alice', 'draft-alice', 'plan.txt', 'text/plain', 12, 'attachment', 'attachments/draft-alice/att-alice/plan.txt', 1);
	`);
	database.db
		.prepare(
			"INSERT INTO api_keys (id, user_id, name, prefix, key_hash, scopes, created_at) VALUES ('key-bob', 'bob', 'Bob', ?, ?, '[\"read\"]', 1)",
		)
		.run(API_KEY.slice(0, 12), bcrypt.hashSync(API_KEY, 4));
	const bucket = memoryBucket();
	bucket.objects.set("attachments/draft-alice/att-alice/plan.txt", "secret bytes");
	const env = { DB: database, BUCKET: bucket, AI: {} };
	globalThis.__kiteNodeEnv = env;
	t.after(() => delete globalThis.__kiteNodeEnv);
	const tokens = {
		alice: await m.createSession(env, "alice"),
		bob: await m.createSession(env, "bob"),
		carol: await m.createSession(env, "carol"),
	};
	const as = (who, path, init = {}) =>
		new Request(`${ORIGIN}${path}`, {
			...init,
			headers: { Origin: ORIGIN, Authorization: `Bearer ${tokens[who]}`, "Content-Type": "application/json" },
		});
	const params = (value) => ({ params: Promise.resolve(value) });
	const status = (id) => database.db.prepare("SELECT status, starred, read FROM messages WHERE id = ?").get(id);
	const exists = (id) => !!database.db.prepare("SELECT 1 FROM messages WHERE id = ?").get(id);
	return { database, env, bucket, as, params, status, exists };
}

const jmap = (env, userId) => ({
	env,
	db: m.getDb(env),
	auth: {
		userId,
		email: `${userId}@example.com`,
		scopes: ["jmap"],
		mailboxIds: null,
		user: { id: userId, email: `${userId}@example.com`, role: "user", isPrimaryAdmin: false, disabled: false },
	},
	accountId: userId,
	origin: ORIGIN,
	createdIds: {},
});
const viewer = (userId) => ({ viewer: { userId, role: "user" }, mailboxIds: ["shared"] });
const ids = (body) => body.messages.map((row) => row.id).sort();

test("isHiddenDraft hides only another user's draft", () => {
	assert.equal(m.isHiddenDraft({ status: "draft", userId: "alice" }, "bob"), true);
	assert.equal(m.isHiddenDraft({ status: "draft", userId: "alice" }, "alice"), false);
	assert.equal(m.isHiddenDraft({ status: "sent", userId: "alice" }, "bob"), false);
	assert.equal(m.isHiddenDraft({ status: "received", userId: "alice" }, "bob"), false);
});

test("another user's draft answers 404 by id; its author still reads it", async (t) => {
	const { as, params } = await fixture(t);
	const one = { messageId: "draft-alice" };
	assert.equal((await m.getMessage(as("bob", "/api/messages/draft-alice"), params(one))).status, 404);
	assert.equal((await m.getMetadata(as("bob", "/api/messages/draft-alice/metadata"), params(one))).status, 404);
	assert.equal((await m.getThread(as("bob", "/api/messages/draft-alice/thread"), params(one))).status, 404);
	assert.equal(
		(await m.getThread(as("bob", "/api/messages/draft-alice-alone/thread"), params({ messageId: "draft-alice-alone" })))
			.status,
		404,
	);
	assert.equal((await m.getOriginal(as("bob", "/api/messages/draft-alice/original"), params(one))).status, 404);
	const attachment = { messageId: "draft-alice", attachmentId: "att-alice" };
	assert.equal(
		(await m.getAttachment(as("bob", "/api/messages/draft-alice/attachments/att-alice"), params(attachment))).status,
		404,
	);

	const own = await m.getMessage(as("alice", "/api/messages/draft-alice"), params(one));
	assert.equal(own.status, 200);
	assert.equal((await own.json()).message.textBody, "Confidential zebra");
	assert.equal((await m.getMetadata(as("alice", "/api/messages/draft-alice/metadata"), params(one))).status, 200);
	const download = await m.getAttachment(
		as("alice", "/api/messages/draft-alice/attachments/att-alice"),
		params(attachment),
	);
	assert.equal(download.status, 200);
	assert.equal(await download.text(), "secret bytes");

	// The mailbox owner gets the same answer for a delegate's draft.
	assert.equal(
		(await m.getMessage(as("alice", "/api/messages/draft-bob"), params({ messageId: "draft-bob" }))).status,
		404,
	);
	const bobs = await m.getMessage(as("bob", "/api/messages/draft-bob"), params({ messageId: "draft-bob" }));
	assert.equal(bobs.status, 200);
});

test("lists, search, counts and navigation show each user only their own drafts", async (t) => {
	const { as } = await fixture(t);
	const list = async (who, query) => (await m.listMessages(as(who, `/api/messages?mailboxId=shared&${query}`))).json();
	assert.deepEqual(ids(await list("bob", "status=draft")), ["draft-bob"]);
	assert.deepEqual(ids(await list("alice", "status=draft")), ["draft-alice", "draft-alice-alone"]);
	assert.deepEqual(ids(await list("bob", "q=zebra")), ["mail-1"]);
	assert.deepEqual(ids(await list("alice", "q=zebra")), ["draft-alice", "mail-1"]);
	assert.deepEqual(ids(await list("bob", "group=thread")), ["draft-bob", "mail-1"]);
	assert.equal((await list("bob", "status=draft")).total, 1);
	// Unscoped (All mailboxes) lists too.
	assert.deepEqual(ids(await (await m.listMessages(as("bob", "/api/messages?status=draft"))).json()), ["draft-bob"]);

	const counts = async (who) =>
		(await (await m.getCounts(as(who, "/api/messages/counts?mailboxId=shared"))).json()).counts;
	assert.equal((await counts("bob")).folders.drafts.total, 1);
	assert.equal((await counts("alice")).folders.drafts.total, 2);
	assert.equal((await counts("bob")).folders.inbox.total, 1);
	assert.equal((await counts("bob")).mailboxes[0].total, 2);

	const navigation = await (
		await m.getNavigation(as("bob", "/api/messages/navigation?folder=drafts&mailboxId=shared"))
	).json();
	assert.doesNotMatch(JSON.stringify(navigation), /draft-alice/);
});

test("another user's draft cannot be changed, forwarded or exported", async (t) => {
	const { as, params, status } = await fixture(t);
	const one = { messageId: "draft-alice" };
	assert.equal(
		(await m.postStar(as("bob", "/api/messages/draft-alice/star", { method: "POST" }), params(one))).status,
		404,
	);
	assert.equal(
		(await m.postRead(as("bob", "/api/messages/draft-alice/read", { method: "POST" }), params(one))).status,
		404,
	);
	const move = await m.postStatus(
		as("bob", "/api/messages/draft-alice/status", { method: "POST", body: JSON.stringify({ status: "trash" }) }),
		params(one),
	);
	assert.equal(move.status, 404);
	const bulk = await m.postBulk(
		as("bob", "/api/messages/bulk", {
			method: "POST",
			body: JSON.stringify({ action: "archive", messageIds: ["draft-alice"] }),
		}),
	);
	assert.equal(bulk.status, 404);
	assert.deepEqual({ ...status("draft-alice") }, { status: "draft", starred: 0, read: 0 });

	const forward = (who) =>
		m.postDraft(
			as(who, "/api/drafts", {
				method: "POST",
				body: JSON.stringify({ from: "team@example.com", mailboxId: "shared", forwardOfMessageId: "draft-alice" }),
			}),
		);
	assert.equal((await forward("bob")).status, 404);
	assert.equal((await forward("alice")).status, 200);

	const mbox = async (who) => (await m.getExport(as(who, "/api/export/messages?mailboxId=shared"))).text();
	const bobs = await mbox("bob");
	assert.doesNotMatch(bobs, /Secret plan|Confidential/);
	assert.match(bobs, /Bob notes/);
	assert.match(bobs, /Hello zebra/);
	assert.match(await mbox("alice"), /Secret plan/);
});

test("the REST API, JMAP and module hosts leave another user's draft out", async (t) => {
	const { env } = await fixture(t);
	const v1 = await (
		await m.getV1Messages(new Request(`${ORIGIN}/api/v1/messages`, { headers: { authorization: `Bearer ${API_KEY}` } }))
	).json();
	assert.deepEqual(ids(v1), ["draft-bob", "mail-1"]);
	const v1Shared = await (
		await m.getV1Messages(
			new Request(`${ORIGIN}/api/v1/messages?mailboxId=shared&q=zebra`, {
				headers: { authorization: `Bearer ${API_KEY}` },
			}),
		)
	).json();
	assert.deepEqual(ids(v1Shared), ["mail-1"]);

	const get = await m.emailGet(jmap(env, "bob"), { accountId: "bob", ids: ["draft-alice", "mail-1"] });
	assert.deepEqual(
		get.list.map((email) => email.id),
		["mail-1"],
	);
	assert.deepEqual(get.notFound, ["draft-alice"]);
	const query = await m.emailQuery(jmap(env, "bob"), { accountId: "bob" });
	assert.deepEqual([...query.ids].sort(), ["draft-bob", "mail-1"]);
	const thread = await m.threadGet(jmap(env, "bob"), { accountId: "bob", ids: ["thread-1"] });
	assert.deepEqual(thread.list, [{ id: "thread-1", emailIds: ["mail-1"] }]);
	assert.equal(await m.readBlob(jmap(env, "bob"), m.attachmentBlobId("att-alice")), null);
	assert.equal(await m.readBlob(jmap(env, "bob"), m.messageBlobId("draft-alice")), null);
	assert.ok(await m.readBlob(jmap(env, "alice"), m.attachmentBlobId("att-alice")));
	const mailboxes = await m.mailboxGet(jmap(env, "bob"), { accountId: "bob", ids: null });
	const drafts = mailboxes.list.find((mailbox) => mailbox.role === "drafts");
	assert.equal(drafts.totalEmails, 1);

	assert.equal(await m.getModuleMessage(env, viewer("bob"), "draft-alice"), null);
	assert.equal(await m.readModuleAttachment(env, viewer("bob"), "draft-alice", "att-alice", { maxBytes: 100 }), null);
	assert.ok(await m.getModuleMessage(env, viewer("alice"), "draft-alice"));
	assert.equal(await m.canProxyMessageImage(env, { id: "bob", role: "user" }, "draft-alice", IMAGE, ORIGIN), false);
	assert.equal(await m.canProxyMessageImage(env, { id: "alice", role: "user" }, "draft-alice", IMAGE, ORIGIN), true);
});

test("an administrator with full access to the mailbox is still not shown another user's draft", async (t) => {
	const { as, params } = await fixture(t);
	const one = { messageId: "draft-alice" };
	assert.equal((await m.getMessage(as("carol", "/api/messages/draft-alice"), params(one))).status, 404);
	const attachment = { messageId: "draft-alice", attachmentId: "att-alice" };
	assert.equal(
		(await m.getAttachment(as("carol", "/api/messages/draft-alice/attachments/att-alice"), params(attachment))).status,
		404,
	);
	const list = async (query) =>
		ids(await (await m.listMessages(as("carol", `/api/messages?mailboxId=shared&${query}`))).json());
	assert.deepEqual(await list("status=draft"), []);
	assert.deepEqual(await list("q=zebra"), ["mail-1"]);
	const counts = await (await m.getCounts(as("carol", "/api/messages/counts?mailboxId=shared"))).json();
	assert.equal(counts.counts.folders.drafts.total, 0);
	const bulk = await m.postBulk(
		as("carol", "/api/messages/bulk", {
			method: "POST",
			body: JSON.stringify({ action: "trash", messageIds: ["draft-alice"] }),
		}),
	);
	assert.equal(bulk.status, 404);
});

test("a draft leaves Drafts only by being sent or deleted, and nothing becomes a draft", () => {
	assert.equal(m.isDraftMoveRefused("draft", "trash"), true);
	assert.equal(m.isDraftMoveRefused("draft", "archived"), true);
	assert.equal(m.isDraftMoveRefused("received", "draft"), true);
	assert.equal(m.isDraftMoveRefused("draft", "draft"), false);
	assert.equal(m.isDraftMoveRefused("received", "trash"), false);
	assert.equal(m.bulkDraftHandling("trash", "draft"), "discard");
	assert.equal(m.bulkDraftHandling("delete", "draft"), "discard");
	assert.equal(m.bulkDraftHandling("read", "draft"), "normal");
	for (const action of ["archive", "spam", "phishing", "inbox", "folder", "restore"])
		assert.equal(m.bulkDraftHandling(action, "draft", "trash"), "refuse", action);
	assert.equal(m.bulkDraftHandling("restore", "trash", "draft"), "refuse");
	assert.equal(m.bulkDraftHandling("restore", "trash", "received"), "normal");
	assert.equal(m.bulkDraftHandling("archive", "received"), "normal");
});

test("deleting your own draft removes it outright, with its attachment, and never exposes it", async (t) => {
	const { as, params, bucket, exists } = await fixture(t);
	const trash = await m.postBulk(
		as("alice", "/api/messages/bulk", {
			method: "POST",
			body: JSON.stringify({ action: "trash", messageIds: ["draft-alice"] }),
		}),
	);
	assert.equal(trash.status, 200);
	const body = await trash.json();
	assert.equal(body.draftsDeleted, 1);
	assert.equal(body.undo, undefined);
	assert.equal(exists("draft-alice"), false);
	assert.equal(bucket.objects.has("attachments/draft-alice/att-alice/plan.txt"), false);
	// Nothing landed in Trash for the rest of the mailbox.
	const bobTrash = await (await m.listMessages(as("bob", "/api/messages?mailboxId=shared&status=trash"))).json();
	assert.deepEqual(ids(bobTrash), []);

	const single = await m.postStatus(
		as("alice", "/api/messages/draft-alice-alone/status", {
			method: "POST",
			body: JSON.stringify({ status: "trash" }),
		}),
		params({ messageId: "draft-alice-alone" }),
	);
	assert.equal(single.status, 200);
	assert.equal(exists("draft-alice-alone"), false);

	// Permanent delete takes a draft too; another user's draft in the same selection is untouched.
	const mixed = await m.postBulk(
		as("bob", "/api/messages/bulk", {
			method: "POST",
			body: JSON.stringify({ action: "delete", messageIds: ["draft-bob", "draft-alice"] }),
		}),
	);
	assert.equal(mixed.status, 200);
	assert.equal(exists("draft-bob"), false);
});

test("moving your own draft to Archive, Spam, Inbox or a folder is refused and it stays private", async (t) => {
	const { as, params, status } = await fixture(t);
	for (const [action, extra] of [
		["archive", {}],
		["spam", {}],
		["phishing", {}],
		["inbox", {}],
		["folder", { folderId: "folder-1" }],
	]) {
		const response = await m.postBulk(
			as("alice", "/api/messages/bulk", {
				method: "POST",
				body: JSON.stringify({ action, messageIds: ["draft-alice"], ...extra }),
			}),
		);
		assert.equal(response.status, 409, action);
		assert.equal((await response.json()).code, "DRAFT_MOVE_REFUSED", action);
		assert.equal(status("draft-alice").status, "draft", action);
	}
	for (const target of ["spam", "received", "sent"]) {
		const response = await m.postStatus(
			as("alice", "/api/messages/draft-alice/status", { method: "POST", body: JSON.stringify({ status: target }) }),
			params({ messageId: "draft-alice" }),
		);
		assert.equal(response.status, 404, target);
		assert.equal(status("draft-alice").status, "draft", target);
	}
	// A mixed selection moves the mail and leaves the draft where it is.
	const mixed = await m.postBulk(
		as("alice", "/api/messages/bulk", {
			method: "POST",
			body: JSON.stringify({ action: "archive", messageIds: ["draft-alice", "mail-1"] }),
		}),
	);
	assert.equal(mixed.status, 200);
	assert.equal((await mixed.json()).draftsRefused, 1);
	assert.equal(status("mail-1").status, "archived");
	assert.equal(status("draft-alice").status, "draft");
	assert.equal(
		(await m.getMessage(as("bob", "/api/messages/draft-alice"), params({ messageId: "draft-alice" }))).status,
		404,
	);
});

test("nobody can move a message into Drafts, where it would be hidden from the mailbox", async (t) => {
	const { env, as, params, status } = await fixture(t);
	const move = await m.postStatus(
		as("bob", "/api/messages/mail-1/status", { method: "POST", body: JSON.stringify({ status: "draft" }) }),
		params({ messageId: "mail-1" }),
	);
	assert.equal(move.status, 400);
	const restore = await m.postBulk(
		as("bob", "/api/messages/bulk", {
			method: "POST",
			body: JSON.stringify({ action: "restore", restore: [{ id: "mail-1", status: "draft", folderId: null }] }),
		}),
	);
	assert.equal(restore.status, 409);
	assert.equal(status("mail-1").status, "received");

	const set = await m.emailSet(jmap(env, "bob"), {
		accountId: "bob",
		update: { "mail-1": { mailboxIds: { "shared~drafts": true } } },
	});
	assert.equal(set.notUpdated["mail-1"].type, "invalidProperties");
	assert.equal(status("mail-1").status, "received");
});

test("JMAP cannot change, destroy or snippet another user's draft, and moves none out of Drafts", async (t) => {
	const { env, exists, status, bucket } = await fixture(t);
	const bob = jmap(env, "bob");
	const set = await m.emailSet(bob, {
		accountId: "bob",
		update: { "draft-alice": { "keywords/$flagged": true, mailboxIds: { "shared~trash": true } } },
		destroy: ["draft-alice"],
	});
	assert.equal(set.notUpdated["draft-alice"].type, "notFound");
	assert.equal(set.notDestroyed["draft-alice"].type, "notFound");
	assert.deepEqual({ ...status("draft-alice") }, { status: "draft", starred: 0, read: 0 });

	const snippets = await m.searchSnippetGet(bob, {
		accountId: "bob",
		emailIds: ["draft-alice", "mail-1"],
		filter: { text: "zebra" },
	});
	assert.deepEqual(
		snippets.list.map((snippet) => snippet.emailId),
		["mail-1"],
	);
	assert.deepEqual(snippets.notFound, ["draft-alice"]);
	assert.doesNotMatch(JSON.stringify(snippets), /Confidential/);

	const alice = jmap(env, "alice");
	const moved = await m.emailSet(alice, {
		accountId: "alice",
		update: { "draft-alice": { mailboxIds: { "shared~inbox": true } } },
	});
	assert.equal(moved.notUpdated["draft-alice"].type, "invalidProperties");
	assert.equal(status("draft-alice").status, "draft");
	const destroyed = await m.emailSet(alice, { accountId: "alice", destroy: ["draft-alice"] });
	assert.deepEqual(destroyed.destroyed, ["draft-alice"]);
	assert.equal(exists("draft-alice"), false);
	assert.equal(bucket.objects.has("attachments/draft-alice/att-alice/plan.txt"), false);
});

test("revoking a member's access deletes their drafts in that mailbox", async (t) => {
	const { database, as, exists } = await fixture(t);
	database.db.exec("UPDATE users SET role = 'admin' WHERE id = 'alice'");
	const response = await m.deleteAccess(as("alice", "/api/mailboxes/shared/access?userId=bob", { method: "DELETE" }), {
		params: Promise.resolve({ id: "shared" }),
	});
	assert.equal(response.status, 200);
	assert.equal(exists("draft-bob"), false);
	assert.equal(exists("draft-alice"), true);
	assert.equal(exists("mail-1"), true);
});
