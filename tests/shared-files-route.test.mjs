import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-shared-files-route-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { GET } from "./src/app/api/shared-files/[id]/route.ts";
		`,
		resolveDir: root,
		sourcefile: "shared-files-route-entry.ts",
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
const { SqliteDatabase, applyMigrations, GET } = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);

const DAY = 24 * 60 * 60;

async function fixture(t) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const now = Math.floor(Date.now() / 1000);
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES
			('owner', 'owner@one.test', 'hash', 'Owner', 'admin', 1, 1),
			('helper', 'helper@one.test', 'hash', 'Helper', 'user', 0, 2);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at)
			VALUES ('one', 'owner', 'one.test', 'zone', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES
			('team', 'owner', 'one', 'team', 'shared', 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, created_at) VALUES
			('sent', 'helper', 'team', 'outbound', 'team@one.test', 'friend@example.com', 'sent', 1),
			('loose', 'owner', NULL, 'outbound', 'owner@one.test', 'friend@example.com', 'sent', 1);
		INSERT INTO message_attachments (id, message_id, filename, content_type, size, disposition, r2_key, created_at) VALUES
			('att', 'sent', 'page.html', 'text/html', 5, 'attachment', 'attachments/sent/att', 1),
			('att2', 'loose', 'notes.txt', 'text/plain', 5, 'attachment', 'attachments/loose/att2', 1);
		INSERT INTO shared_attachment_links (id, attachment_id, expires_at, created_at) VALUES
			('share_live', 'att', ${now + 30 * DAY}, ${now}),
			('share_loose', 'att2', ${now + 30 * DAY}, ${now});
	`);
	const env = {
		DB: database,
		BUCKET: { get: async () => ({ body: new Response("bytes").body }) },
	};
	globalThis.__kiteNodeEnv = env;
	t.after(() => delete globalThis.__kiteNodeEnv);
	const sql = (statement) => database.db.exec(statement);
	const call = (id) =>
		GET(new Request(`https://mail.example.com/api/shared-files/${id}`), { params: Promise.resolve({ id }) });
	return { call, sql };
}

test("a live link downloads opaque bytes with a safe name", async (t) => {
	const { call } = await fixture(t);
	const response = await call("share_live");
	assert.equal(response.status, 200);
	assert.equal(await response.text(), "bytes");
	assert.equal(response.headers.get("content-type"), "application/octet-stream", "never the sender's text/html");
	assert.match(response.headers.get("content-disposition"), /^attachment; filename="page\.html"/);
	assert.equal(response.headers.get("x-content-type-options"), "nosniff");
	assert.equal((await call("share_loose")).status, 200, "a message without a mailbox still serves");
});

for (const status of ["trash", "spam", "screening"]) {
	test(`a link dies while its message is in ${status}`, async (t) => {
		const { call, sql } = await fixture(t);
		sql(`UPDATE messages SET status = '${status}' WHERE id = 'sent'`);
		assert.equal((await call("share_live")).status, 404);
		sql(`UPDATE messages SET status = 'sent' WHERE id = 'sent'`);
		assert.equal((await call("share_live")).status, 200, "it works again once restored");
	});
}

test("a link dies with a disabled mailbox, message owner or mailbox owner", async (t) => {
	const { call, sql } = await fixture(t);
	sql(`UPDATE mailboxes SET disabled = 1 WHERE id = 'team'`);
	assert.equal((await call("share_live")).status, 404, "disabled mailbox");
	sql(`UPDATE mailboxes SET disabled = 0 WHERE id = 'team'`);
	sql(`UPDATE users SET disabled = 1 WHERE id = 'helper'`);
	assert.equal((await call("share_live")).status, 404, "disabled message owner");
	sql(`UPDATE users SET disabled = 0 WHERE id = 'helper'`);
	sql(`UPDATE users SET disabled = 1 WHERE id = 'owner'`);
	assert.equal((await call("share_live")).status, 404, "disabled mailbox owner");
	assert.equal((await call("share_loose")).status, 404, "disabled owner of a message without a mailbox");
});

test("expired and unknown links answer 404", async (t) => {
	const { call, sql } = await fixture(t);
	sql(`UPDATE shared_attachment_links SET expires_at = 1 WHERE id = 'share_live'`);
	assert.equal((await call("share_live")).status, 404);
	assert.equal((await call("share_missing")).status, 404);
});
