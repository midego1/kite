import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

// C-1 of review round 3: with search by meaning off (the default on every install), a free-text search must behave
// exactly like the plain keyword search did before this feature existed — real total, newest-first order, cursor
// paging past the first page — not the fused/capped/unpaged hybrid path, which `semanticSearch` used to still
// answer "on" for quietly. 120 matches, well past the hybrid path's 50-result cap, makes the difference visible.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-semantic-keyword-fallback-test-");
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createSession } from "./src/lib/auth/session.ts";
			export { GET as listMessages } from "./src/app/api/messages/route.ts";
		`,
		resolveDir: root,
		sourcefile: "semantic-keyword-fallback-test-entry.ts",
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

/** 120 messages matching "invoice" in one mailbox, newest last (`created_at` ascending ids), search by meaning off
 * (the migration's own default — nothing turns it on here). */
async function fixture(t) {
	const database = new m.SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await m.applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('owner', 'owner@example.test', 'hash', 'Owner', 'admin', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain', 'owner', 'example.test', 'zone', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('box', 'owner', 'domain', 'owner', 1);
	`);
	const rows = Array.from(
		{ length: 120 },
		(_, index) =>
			`('invoice-${String(index).padStart(3, "0")}', 'owner', 'box', 'inbound', 'a@partner.test', 'owner@example.test', 'Invoice ${index}', 'received', ${index + 1})`,
	).join(",\n");
	database.db.exec(
		`INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, created_at) VALUES ${rows};`,
	);
	const env = { DB: database, KITE_RUNTIME: "node" };
	globalThis.__kiteNodeEnv = env;
	t.after(() => {
		delete globalThis.__kiteNodeEnv;
	});
	const session = await m.createSession(env, "owner");
	return async (query) => {
		const response = await m.listMessages(
			new Request(`https://kite.test/api/messages?mailboxId=box&status=received&${query}`, {
				headers: { Authorization: `Bearer ${session}` },
			}),
		);
		const body = await response.json();
		assert.equal(response.status, 200, JSON.stringify(body));
		return body;
	};
}

test("a free-text search with more matches than the hybrid cap keeps its real total, date order and cursor paging while the feature is off", async (t) => {
	const list = await fixture(t);
	const first = await list("q=invoice&limit=50");
	assert.equal(first.total, 120, "the true keyword total, not capped at 50");
	assert.equal(first.messages.length, 50);
	assert.equal(first.semantic, undefined, "quiet: nothing attempted, nothing to report");
	// Newest first, exactly as the plain keyword path has always ordered (the hybrid path orders by bm25 rank
	// instead, oldest-ranked-first among ties for this fixture, which this would catch).
	assert.deepEqual(
		first.messages.map((row) => row.id),
		Array.from({ length: 50 }, (_, index) => `invoice-${String(119 - index).padStart(3, "0")}`),
	);
	assert.ok(first.nextCursor, "a real cursor, not null, since more than 50 matched");

	const second = await list(`q=invoice&limit=50&cursor=${encodeURIComponent(first.nextCursor)}`);
	assert.equal(second.total, 120);
	assert.equal(second.messages.length, 50);
	assert.deepEqual(
		second.messages.map((row) => row.id),
		Array.from({ length: 50 }, (_, index) => `invoice-${String(69 - index).padStart(3, "0")}`),
	);

	const third = await list(`q=invoice&limit=50&cursor=${encodeURIComponent(second.nextCursor)}`);
	assert.equal(third.messages.length, 20);
	assert.equal(third.nextCursor, null, "the last page");
	assert.deepEqual(
		third.messages.map((row) => row.id),
		Array.from({ length: 20 }, (_, index) => `invoice-${String(19 - index).padStart(3, "0")}`),
	);
});
