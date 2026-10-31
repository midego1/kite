import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

// `moved` in a bulk response names the messages that really left their folder, which is what closes an open reader.
// It is not `undo`: Trash or Archive of a failed send moves it, though a failed send is not restorable.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-bulk-moved-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
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
const { POST: bulkMessages } = await load("bulkRoute");
const { createSession } = await load("session");
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");

let count = 0;
async function setup(t) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, join(root, "drizzle/migrations"));
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Owner', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'a', 1);
	`);
	// Delete forever removes stored objects too; nothing is stored here.
	const env = {
		DB: db,
		BUCKET: {
			delete: async () => {},
			get: async () => null,
			head: async () => null,
			list: async () => ({ objects: [], truncated: false }),
		},
	};
	globalThis.__kiteNodeEnv = env;
	t.after(() => delete globalThis.__kiteNodeEnv);
	const addMessage = ({ status = "received", direction = "inbound" } = {}) => {
		const id = `msg-${++count}`;
		db.db
			.prepare(
				"INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at) VALUES (?, 'owner', 'mailbox-a', ?, 'deals@promo.test', 'a@example.com', 'Limited offer', 'Buy now.', ?, ?)",
			)
			.run(id, direction, status, count);
		return id;
	};
	const statusOf = (id) => db.db.prepare("SELECT status FROM messages WHERE id = ?").get(id)?.status;
	return { env, addMessage, statusOf };
}

async function bulk(env, body) {
	const token = await createSession(env, "owner");
	const response = await bulkMessages(
		new Request("https://kite.test/api/messages/bulk", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
	return { status: response.status, json: await response.json() };
}

test("Trash of a failed send names it in moved although Undo cannot restore it", async (t) => {
	const { env, addMessage, statusOf } = await setup(t);
	const failed = addMessage({ status: "failed", direction: "outbound" });
	const { status, json } = await bulk(env, { action: "trash", messageIds: [failed] });
	assert.equal(status, 200);
	assert.equal(statusOf(failed), "trash");
	assert.deepEqual(json.undo, []);
	assert.deepEqual(json.moved, [failed]);
});

test("a queued send is refused and is not in moved", async (t) => {
	const { env, addMessage, statusOf } = await setup(t);
	const queued = addMessage({ status: "queued", direction: "outbound" });
	const other = addMessage();
	const { json } = await bulk(env, { action: "archive", messageIds: [queued, other] });
	assert.equal(statusOf(queued), "queued");
	assert.deepEqual(json.moved, [other]);
	assert.equal(json.sendPendingRefused, 1);
});

test("a spam report names only what it reported: sent mail is never reported", async (t) => {
	const { env, addMessage, statusOf } = await setup(t);
	const received = addMessage();
	const sent = addMessage({ status: "sent", direction: "outbound" });
	const { json } = await bulk(env, { action: "spam", messageIds: [received, sent] });
	assert.equal(statusOf(received), "spam");
	assert.equal(statusOf(sent), "sent");
	assert.deepEqual(json.moved, [received]);
});

test("Not spam, a folder-less move and Delete forever name what they moved; read state names nothing", async (t) => {
	const { env, addMessage, statusOf } = await setup(t);
	const spam = addMessage({ status: "spam" });
	assert.deepEqual((await bulk(env, { action: "inbox", messageIds: [spam] })).json.moved, [spam]);
	assert.equal(statusOf(spam), "received");

	const read = await bulk(env, { action: "read", messageIds: [spam] });
	assert.equal(read.json.moved, undefined);

	const trashed = addMessage({ status: "trash" });
	const inbox = addMessage();
	const deleted = await bulk(env, { action: "delete", messageIds: [trashed, inbox] });
	assert.deepEqual(deleted.json.moved, [trashed]);
	assert.equal(statusOf(trashed), undefined);
	assert.equal(statusOf(inbox), "received");
});
