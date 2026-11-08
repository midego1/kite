import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

// The allowlist of tools an email request may call (docs/specs/assistant-by-email.md §8.3): every core email tool,
// pending_approval for the organise ones, and module tools filtered to a read-only effect.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-assistant-email-tools-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { runEmailTool, EMAIL_TOOL_NAMES } from "./src/lib/agent/tools.ts";
			export { buildEmailChatTools } from "./src/lib/agent/email/email-tools.ts";
		`,
		resolveDir: root,
		sourcefile: "assistant-email-tools-entry.ts",
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
const { SqliteDatabase, applyMigrations, runEmailTool, EMAIL_TOOL_NAMES, buildEmailChatTools } = await import(
	pathToFileURL(join(bundleDirectory, "entry.mjs")).href
);

const OWNER = { id: "user-1", email: "owner@example.com", role: "user", isPrimaryAdmin: true };

async function setup(t) {
	const directory = mkdtempSync(join(tmpdir(), "kite-assistant-email-tools-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const database = new SqliteDatabase(join(directory, "kite.sqlite"));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle", "migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('user-1', 'owner@example.com', 'hash', 'Owner', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'user-1', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-1', 'user-1', 'domain-1', 'owner', 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, read, created_at)
			VALUES ('m1', 'user-1', 'mailbox-1', 'inbound', 'a@example.net', 'owner@example.com', 'Invoice', 'Body', 'received', 1, 1);
	`);
	const env = { DB: database, BUCKET: { get: async () => null, delete: async () => {} } };
	globalThis.__kiteNodeEnv = env;
	t.after(() => delete globalThis.__kiteNodeEnv);
	return { database, env };
}

test("every core email tool is offered by email, and the organise tools always need approval there", async (t) => {
	const { env } = await setup(t);
	const email = { env, user: OWNER, mailboxId: "mailbox-1", origin: "email" };
	const { tools } = await buildEmailChatTools(email);
	for (const name of EMAIL_TOOL_NAMES) assert.ok(tools[name], `${name} is offered by email`);

	const mark = await runEmailTool(email, "mark_email_read", { emailId: "m1", read: false });
	assert.equal(mark.status, "pending_approval");
	const move = await runEmailTool(email, "move_email", { emailId: "m1", destination: "archived" });
	assert.equal(move.status, "pending_approval");
	const folder = await runEmailTool(email, "create_folder", { name: "Bills" });
	assert.equal(folder.status, "pending_approval");
	// Read-only tools run straight through, same as for chat.
	const listed = await runEmailTool(email, "list_folders", {});
	assert.deepEqual(listed.folders, []);
});

test("a draft review is offered by email and creates a review link, same as chat", async (t) => {
	const { database, env } = await setup(t);
	const email = { env, user: OWNER, mailboxId: "mailbox-1", origin: "email" };
	const draft = await runEmailTool(email, "draft_email", {
		to: "jan@example.net",
		subject: "Tuesday",
		body: "Works for me.",
	});
	const review = await runEmailTool(email, "review_draft_send", { draftId: draft.draftId, expectedRevision: 1 });
	assert.equal(review.status, "pending_approval");
	assert.match(review.reviewUrl, /^\/agent\/review\//);
	database.db.exec("DELETE FROM agent_send_approvals");
});

test("a chat-only tool refuses an unknown origin, so a future caller cannot bypass the allowlist by accident", async (t) => {
	const { env } = await setup(t);
	const mcp = { env, user: OWNER, mailboxId: "mailbox-1", origin: "mcp" };
	const draft = await runEmailTool(mcp, "draft_email", { to: "jan@example.net", subject: "Hi", body: "Hi" });
	await assert.rejects(
		runEmailTool(mcp, "review_draft_send", { draftId: draft.draftId, expectedRevision: 1 }),
		/Open the draft in Kite/,
	);
});

test("buildEmailChatTools offers a module's read-only tools but never one with a write effect", async (t) => {
	const { env } = await setup(t);
	const email = { env, user: OWNER, mailboxId: "mailbox-1", origin: "email", timeZone: "UTC" };
	const { tools } = await buildEmailChatTools(email);
	assert.ok(tools.get_schedule, "a read-effect module tool is offered");
	assert.ok(!tools.create_event, "a create-effect module tool is never offered by email");
	assert.ok(!tools.update_events, "an update-effect module tool is never offered by email");
	assert.ok(!tools.delete_events, "a delete-effect module tool is never offered by email");
	assert.ok(tools.list_emails && tools.draft_email && tools.open_page, "every core tool is still offered");
});
