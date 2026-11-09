import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

// The conversation list's envelope badge names the request's From address (spec §8.4, §14); when several
// requests share one conversation it must be the original (oldest) one, whatever order the rows come back in.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-assistant-email-conversation-sender-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { listAgentConversations } from "./src/lib/agent/chat.ts";
		`,
		resolveDir: root,
		sourcefile: "assistant-email-conversation-sender-entry.ts",
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
const { SqliteDatabase, applyMigrations, listAgentConversations } = await import(
	pathToFileURL(join(bundleDirectory, "entry.mjs")).href
);

const OWNER = { id: "user-1", email: "owner@example.com", role: "user", isPrimaryAdmin: true };

test("the badge names the conversation's first request, not whichever row the database returns first", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "kite-assistant-email-conversation-sender-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const database = new SqliteDatabase(join(directory, "kite.sqlite"));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle", "migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('user-1', 'owner@example.com', 'hash', 'Owner', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'user-1', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-1', 'user-1', 'domain-1', 'owner', 1);
		INSERT INTO agent_conversations (id, user_id, mailbox_id, title, created_at, updated_at) VALUES ('c1', 'user-1', 'mailbox-1', 'Roof', 1, 1);
		-- The later request has the smaller id, so an id-ordered or arbitrary pick would return the wrong sender.
		INSERT INTO assistant_email_requests (id, user_id, mailbox_id, conversation_id, provider_message_id, from_addr, status, created_at)
			VALUES ('r-a', 'user-1', 'mailbox-1', 'c1', '<later@example.com>', 'phone@example.net', 'answered', 20);
		INSERT INTO assistant_email_requests (id, user_id, mailbox_id, conversation_id, provider_message_id, from_addr, status, created_at)
			VALUES ('r-z', 'user-1', 'mailbox-1', 'c1', '<first@example.com>', 'owner@example.com', 'answered', 10);
	`);
	globalThis.__kiteNodeEnv = { DB: database, BUCKET: { get: async () => null, delete: async () => {} } };
	t.after(() => delete globalThis.__kiteNodeEnv);
	const rows = await listAgentConversations({ env: globalThis.__kiteNodeEnv, user: OWNER, mailboxId: "mailbox-1" });
	assert.equal(rows.length, 1);
	assert.equal(rows[0].viaEmailFrom, "owner@example.com");
});
