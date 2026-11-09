import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

// PATCH /api/settings/assistant refuses a foreign mailbox before it saves anything else in the same request,
// and the mailbox picker lists personal mailboxes oldest first (the one intake falls back to is the first).

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-assistant-settings-route-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
const stubSession = {
	name: "stub-session",
	setup(build) {
		build.onResolve({ filter: /^@\/lib\/api\/auth$/ }, (args) => ({ path: args.path, namespace: "stub" }));
		build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
			contents: `export async function requireSessionUser() {
				return { user: { id: "user-1", email: "owner@example.com", role: "user", agentMaxSteps: 8 } };
			}`,
			loader: "js",
		}));
	},
};
await build({
	entryPoints: { route: join(root, "src/app/api/settings/assistant/route.ts") },
	outdir: bundleDirectory,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	sourcemap: "inline",
	absWorkingDir: root,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	plugins: [stubSession],
	alias: {
		"next/server": "next/server.js",
		"cloudflare:workers": "./server/runtime/cloudflare-workers.ts",
	},
	logLevel: "silent",
});
const dbEntry = await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
		`,
		resolveDir: root,
		sourcefile: "assistant-settings-route-db.ts",
	},
	outfile: join(bundleDirectory, "db.mjs"),
	bundle: true,
	absWorkingDir: root,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});
void dbEntry;
const { PATCH, GET } = await import(pathToFileURL(join(bundleDirectory, "route.mjs")).href);
const { SqliteDatabase, applyMigrations } = await import(pathToFileURL(join(bundleDirectory, "db.mjs")).href);

async function setup(t) {
	const directory = mkdtempSync(join(tmpdir(), "kite-assistant-settings-route-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const database = new SqliteDatabase(join(directory, "kite.sqlite"));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle", "migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('user-1', 'owner@example.com', 'hash', 'Owner', 1);
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('user-2', 'other@example.com', 'hash', 'Other', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'user-1', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb-newer', 'user-1', 'domain-1', 'newer', 200);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb-older', 'user-1', 'domain-1', 'older', 100);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb-foreign', 'user-2', 'domain-1', 'foreign', 50);
	`);
	globalThis.__kiteNodeEnv = { DB: database, BUCKET: { get: async () => null, delete: async () => {} } };
	t.after(() => delete globalThis.__kiteNodeEnv);
	return database;
}

const INSTRUCTIONS = { general: "Always be brief.", chat: "", draft: "", summary: "" };

const patch = (body) =>
	PATCH(
		new Request("http://localhost/api/settings/assistant", {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Origin: "http://localhost" },
			body: JSON.stringify(body),
		}),
	);

test("a mailbox that is not the user's own personal one saves nothing, not even the instructions beside it", async (t) => {
	const database = await setup(t);
	const response = await patch({
		instructions: INSTRUCTIONS,
		emailAssistant: { enabled: true, mailboxId: "mb-foreign" },
	});
	assert.equal(response.status, 400);
	const row = database.db.prepare("SELECT * FROM user_ai_settings WHERE user_id = 'user-1'").get();
	assert.equal(row, undefined);
});

test("the mailbox picker lists personal mailboxes oldest first", async (t) => {
	await setup(t);
	const response = await GET(new Request("http://localhost/api/settings/assistant"));
	const data = await response.json();
	assert.deepEqual(
		data.emailAssistant.mailboxes.map((mailbox) => mailbox.id),
		["mb-older", "mb-newer"],
	);
});

test("a request that needs the assistant-by-email migration saves nothing while it is pending, not even the instructions beside it", async (t) => {
	const database = await setup(t);
	database.db.exec(`
		ALTER TABLE user_ai_settings DROP COLUMN assistant_email_enabled;
		ALTER TABLE user_ai_settings DROP COLUMN assistant_email_mailbox_id;
		ALTER TABLE user_ai_settings DROP COLUMN assistant_email_daily_limit;
	`);
	const stepsBefore = database.db.prepare("SELECT agent_max_steps FROM users WHERE id = 'user-1'").get();
	const response = await patch({
		instructions: INSTRUCTIONS,
		emailAssistant: { enabled: true },
		maxSteps: 7,
	});
	assert.equal(response.status, 409);
	assert.equal((await response.json()).code, "MIGRATION_PENDING");
	assert.equal(database.db.prepare("SELECT * FROM user_ai_settings WHERE user_id = 'user-1'").get(), undefined);
	assert.deepEqual(database.db.prepare("SELECT agent_max_steps FROM users WHERE id = 'user-1'").get(), stepsBefore);

	// What the pending migration does not touch still saves.
	const instructionsOnly = await patch({ instructions: INSTRUCTIONS });
	assert.equal(instructionsOnly.status, 200);
});

test("a request that needs the settings table saves nothing while that migration is pending", async (t) => {
	const database = await setup(t);
	database.db.exec("DROP TABLE user_ai_settings");
	const stepsBefore = database.db.prepare("SELECT agent_max_steps FROM users WHERE id = 'user-1'").get();
	const response = await patch({ instructions: INSTRUCTIONS, maxSteps: 7 });
	assert.equal(response.status, 409);
	assert.equal((await response.json()).code, "MIGRATION_PENDING");
	assert.deepEqual(database.db.prepare("SELECT agent_max_steps FROM users WHERE id = 'user-1'").get(), stepsBefore);
});
