import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

// N-3 of review round 6: `search_emails` with `mode: "meaning"` used to return early whenever meaning did not run
// (the feature off, the default on every install; or a genuine runtime failure), skipping the query's own keyword
// conditions entirely — so it answered the mailbox's newest mail, unfiltered, labelled "these are keyword results
// instead". Both of this file's tests insert mail that does not match the query alongside mail that does, so a
// result containing the non-matching mail would be caught.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-semantic-search-emails-tool-test-");
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { runEmailTool } from "./src/lib/agent/tools.ts";
		`,
		resolveDir: root,
		sourcefile: "semantic-search-emails-tool-test-entry.ts",
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
		"cloudflare:workers": "./server/runtime/cloudflare-workers.ts",
	},
	logLevel: "silent",
});
const m = await import(pathToFileURL(join(directory, "entry.mjs")).href);

test('search_emails mode: "meaning" filters by the query when the feature is off, the default on every install (N-3 of review round 6)', async (t) => {
	const database = new m.SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await m.applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('owner', 'owner@example.test', 'hash', 'Owner', 'admin', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain', 'owner', 'example.test', 'zone', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('box', 'owner', 'domain', 'owner', 1);
	`);
	const matching = Array.from(
		{ length: 20 },
		(_, index) =>
			`('kw-${String(index).padStart(2, "0")}', 'owner', 'box', 'inbound', 'a@partner.test', 'owner@example.test', 'Invoice ${index}', 'received', ${index + 1})`,
	).join(",\n");
	const other = Array.from(
		{ length: 20 },
		(_, index) =>
			`('other-${String(index).padStart(2, "0")}', 'owner', 'box', 'inbound', 'a@partner.test', 'owner@example.test', 'Weekend plans ${index}', 'received', ${1000 + index})`,
	).join(",\n");
	database.db.exec(
		`INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, created_at) VALUES ${matching}, ${other};`,
	);
	const env = { DB: database, KITE_RUNTIME: "node" };
	const context = {
		env,
		user: { id: "owner", email: "owner@example.test", role: "admin" },
		mailboxId: "box",
		origin: "mcp",
	};

	const result = await m.runEmailTool(context, "search_emails", { query: "invoice", mode: "meaning", limit: 50 });
	assert.equal(result.emails.length, 20, "only the matching messages, not the mailbox's newest mail unfiltered");
	assert.ok(
		result.emails.every((email) => email.subject.startsWith("Invoice")),
		JSON.stringify(result.emails.map((email) => email.subject)),
	);
	assert.match(result.note, /did not run/);
});

test('search_emails mode: "meaning" still filters by the query when meaning genuinely fails (no vector store configured)', async (t) => {
	const database = new m.SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await m.applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('owner', 'owner@example.test', 'hash', 'Owner', 'admin', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain', 'owner', 'example.test', 'zone', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('box', 'owner', 'domain', 'owner', 1);
		INSERT INTO app_settings (id, semantic_search_enabled, updated_at) VALUES ('default', 1, 1)
			ON CONFLICT(id) DO UPDATE SET semantic_search_enabled = 1;
	`);
	const matching = Array.from(
		{ length: 20 },
		(_, index) =>
			`('kw-${String(index).padStart(2, "0")}', 'owner', 'box', 'inbound', 'a@partner.test', 'owner@example.test', 'Invoice ${index}', 'received', ${index + 1})`,
	).join(",\n");
	const other = Array.from(
		{ length: 20 },
		(_, index) =>
			`('other-${String(index).padStart(2, "0")}', 'owner', 'box', 'inbound', 'a@partner.test', 'owner@example.test', 'Weekend plans ${index}', 'received', ${1000 + index})`,
	).join(",\n");
	database.db.exec(
		`INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, created_at) VALUES ${matching}, ${other};`,
	);
	// The feature is on and the embedding call itself would succeed, but no vector store is configured for this
	// runtime (no VECTORS binding, no VECTORIZE, no SEMANTIC_TEST_STORE): a genuine runtime failure, not "off".
	const env = {
		DB: database,
		KITE_RUNTIME: "node",
		AI: { run: async () => ({ data: [Array(1024).fill(0.01)] }) },
	};
	const context = {
		env,
		user: { id: "owner", email: "owner@example.test", role: "admin" },
		mailboxId: "box",
		origin: "mcp",
	};

	const result = await m.runEmailTool(context, "search_emails", { query: "invoice", mode: "meaning", limit: 50 });
	assert.equal(result.emails.length, 20, "only the matching messages, not the mailbox's newest mail unfiltered");
	assert.ok(
		result.emails.every((email) => email.subject.startsWith("Invoice")),
		JSON.stringify(result.emails.map((email) => email.subject)),
	);
	assert.match(result.note, /unavailable right now \(no_vector_store\)/);
});
