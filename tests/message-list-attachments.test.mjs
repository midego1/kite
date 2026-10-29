import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-message-list-attachments-test-");
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createSession } from "./src/lib/auth/session.ts";
			export { GET as listMessages } from "./src/app/api/messages/route.ts";
			export { rowsWithAttachments } from "./src/lib/messages/attachment-flags-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "message-list-attachments-test-entry.ts",
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

/** A mailbox with: a message with a PDF, a plain one, one with only a cid-referenced inline image, and a thread whose older message has the PDF. */
async function fixture(t, extraThreadMessages = 0) {
	const database = new m.SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await m.applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('owner', 'owner@example.test', 'hash', 'Owner', 'admin', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain', 'owner', 'example.test', 'zone', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('box', 'owner', 'domain', 'owner', 1);
		INSERT INTO messages (id, user_id, mailbox_id, thread_id, direction, from_addr, to_addr, subject, status, read, created_at) VALUES
			('with-pdf', 'owner', 'box', NULL, 'inbound', 'a@partner.test', 'owner@example.test', 'Invoice', 'received', 0, 1),
			('plain', 'owner', 'box', NULL, 'inbound', 'b@partner.test', 'owner@example.test', 'Hello', 'received', 0, 2),
			('inline-only', 'owner', 'box', NULL, 'inbound', 'c@partner.test', 'owner@example.test', 'Newsletter', 'received', 0, 3),
			('t-old', 'owner', 'box', 'thread', 'inbound', 'd@partner.test', 'owner@example.test', 'Plan', 'received', 0, 4),
			('t-new', 'owner', 'box', 'thread', 'inbound', 'd@partner.test', 'owner@example.test', 'Re: Plan', 'received', 0, 5),
			('p-in', 'owner', 'box', 'private', 'inbound', 'f@partner.test', 'owner@example.test', 'Offer', 'received', 0, 6),
			('p-trash', 'owner', 'box', 'private', 'inbound', 'f@partner.test', 'owner@example.test', 'Re: Offer', 'trash', 1, 7),
			('p-draft', 'owner', 'box', 'private', 'outbound', 'owner@example.test', 'f@partner.test', 'Re: Offer', 'draft', 1, 8);
		INSERT INTO message_attachments (id, message_id, filename, content_type, size, disposition, content_id, r2_key, created_at) VALUES
			('att-pdf', 'with-pdf', 'invoice.pdf', 'application/pdf', 10, 'attachment', NULL, 'k1', 1),
			('att-logo', 'inline-only', 'logo.png', 'image/png', 10, 'inline', 'logo@cid', 'k2', 1),
			('att-old', 't-old', 'plan.pdf', 'application/pdf', 10, 'attachment', NULL, 'k3', 1),
			('att-trash', 'p-trash', 'old.pdf', 'application/pdf', 10, 'attachment', NULL, 'k5', 1),
			('att-draft', 'p-draft', 'draft.pdf', 'application/pdf', 10, 'attachment', NULL, 'k6', 1);
	`);
	for (let index = 0; index < extraThreadMessages; index++) {
		database.db
			.prepare(
				"INSERT INTO messages (id, user_id, mailbox_id, thread_id, direction, from_addr, to_addr, subject, status, read, created_at) VALUES (?, 'owner', 'box', 'big', 'inbound', 'e@partner.test', 'owner@example.test', 'Big', 'received', 1, ?)",
			)
			.run(`big-${index}`, 100 + index);
	}
	if (extraThreadMessages > 0) {
		database.db
			.prepare(
				"INSERT INTO message_attachments (id, message_id, filename, content_type, size, disposition, r2_key, created_at) VALUES ('att-big', 'big-0', 'big.zip', 'application/zip', 10, 'attachment', 'k4', 1)",
			)
			.run();
	}
	const env = { DB: database, KITE_RUNTIME: "node" };
	globalThis.__kiteNodeEnv = env;
	t.after(() => {
		delete globalThis.__kiteNodeEnv;
	});
	const session = await m.createSession(env, "owner");
	return async (query) => {
		const response = await m.listMessages(
			new Request(
				`https://kite.test/api/messages?mailboxId=box&${query.includes("status=") ? "" : "status=received&"}limit=100&${query}`,
				{
					headers: { Authorization: `Bearer ${session}` },
				},
			),
		);
		assert.equal(response.status, 200);
		const body = await response.json();
		return new Map(body.messages.map((row) => [row.id, row]));
	};
}

test("a list row has hasAttachments only for a real attachment, not a cid-referenced inline image", async (t) => {
	const list = await fixture(t);
	const rows = await list("");
	assert.equal(rows.get("with-pdf").hasAttachments, true);
	assert.equal(rows.get("plain").hasAttachments, false);
	assert.equal(rows.get("inline-only").hasAttachments, false);
	assert.equal(rows.get("t-old").hasAttachments, true);
	assert.equal(rows.get("t-new").hasAttachments, false);
});

test("a conversation row has hasAttachments when any message it stands for does", async (t) => {
	const list = await fixture(t);
	const rows = await list("group=thread");
	assert.equal(rows.get("t-new").hasAttachments, true, "the newest message has none, an older one does");
	assert.equal(rows.get("with-pdf").hasAttachments, true);
	assert.equal(rows.get("plain").hasAttachments, false);
});

test("a conversation row ignores attachments on messages outside the folder view (trash, drafts)", async (t) => {
	const list = await fixture(t);
	const rows = await list("group=thread");
	const row = rows.get("p-in");
	assert.deepEqual(row.threadMessageIds, ["p-in"]);
	assert.equal(row.hasAttachments, false, "the only attachments are on a trashed message and a draft");
	assert.equal((await list("status=trash")).get("p-trash").hasAttachments, true, "the trash view itself shows it");
});

test("a conversation of far more than 100 messages still answers in one lookup", async (t) => {
	const list = await fixture(t, 250);
	const rows = await list("group=thread");
	const big = [...rows.values()].find((row) => row.threadId === "big");
	assert.equal(big.threadMessageIds.length, 250);
	assert.equal(big.hasAttachments, true);
	assert.equal(rows.get("plain").hasAttachments, false);
});

test("rowsWithAttachments flags a row when any of its messages is in the set", () => {
	const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
	const members = { a: ["a"], b: ["b1", "b2"], c: ["c1"] };
	const flagged = m.rowsWithAttachments(rows, (row) => members[row.id], new Set(["b2", "other"]));
	assert.deepEqual([...flagged], ["b"]);
	assert.equal(m.rowsWithAttachments([], () => [], new Set(["x"])).size, 0);
});
