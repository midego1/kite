import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-pending-columns-bundle-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createDb } from "./src/db/index.ts";
			export { domains } from "./src/db/schema/index.ts";
			export { insertRow, selectRow, selectRows } from "./src/lib/db/pending-columns.ts";
			export * from "./src/lib/db/pending-columns-utils.ts";
			export { addDomainForUser, getDomainForUser, listUserDomains } from "./src/lib/domains/service.ts";
			export { resolveInboundAddress } from "./src/lib/email/routing.ts";
		`,
		resolveDir: root,
		sourcefile: "pending-columns-entry.ts",
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
const kite = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);

const columns = {
	id: { name: "id" },
	dnsSkipped: { name: "dns_skipped", default: false },
	createdAt: { name: "created_at" },
};

test("presentColumnKeys leaves out the columns the database does not have", () => {
	assert.deepEqual(kite.presentColumnKeys(columns, new Set()), ["id", "dnsSkipped", "createdAt"]);
	assert.deepEqual(kite.presentColumnKeys(columns, new Set(["dns_skipped"])), ["id", "createdAt"]);
});

test("isTableColumn matches SQL column names, not property keys", () => {
	assert.equal(kite.isTableColumn(columns, "dns_skipped"), true);
	assert.equal(kite.isTableColumn(columns, "dnsSkipped"), false);
});

test("fillMissingColumns sets each missing column to its default or null", () => {
	assert.deepEqual(kite.fillMissingColumns({ id: "a" }, columns, new Set(["dns_skipped", "created_at"])), {
		id: "a",
		dnsSkipped: false,
		createdAt: null,
	});
});

test("canOmitMissingColumns only drops values the migration would fill in anyway", () => {
	const missing = new Set(["dns_skipped"]);
	assert.equal(kite.canOmitMissingColumns({ id: "a" }, columns, missing), true);
	assert.equal(kite.canOmitMissingColumns({ id: "a", dnsSkipped: false }, columns, missing), true);
	assert.equal(kite.canOmitMissingColumns({ id: "a", dnsSkipped: true }, columns, missing), false);
	assert.equal(kite.canOmitMissingColumns({ id: "a", dnsSkipped: true }, columns, new Set()), true);
});

async function databaseWithout(t, column) {
	const directory = mkdtempSync(join(tmpdir(), "kite-pending-columns-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const database = new kite.SqliteDatabase(join(directory, "kite.sqlite"));
	t.after(() => database.db.close());
	await kite.applyMigrations(database, join(root, "drizzle", "migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('user-1', 'owner@example.test', 'hash', 'Owner', 1);
		ALTER TABLE domains DROP COLUMN ${column};
	`);
	return { DB: database };
}

test("domains still read, insert and route mail before a new domains column is migrated", async (t) => {
	const env = await databaseWithout(t, "receiving_provider");
	const added = await kite.addDomainForUser(env, "user-1", "pending.example.test", { sendingProvider: "none" });
	assert.equal(added.domain.hostname, "pending.example.test");
	assert.equal(added.domain.receivingProvider, "cloudflare");

	const [listed] = await kite.listUserDomains(env, "user-1");
	assert.equal(listed.id, added.domain.id);
	assert.equal(listed.receivingProvider, "cloudflare");
	assert.equal((await kite.getDomainForUser(env, "user-1", added.domain.id))?.hostname, "pending.example.test");

	const db = kite.createDb(env.DB);
	assert.deepEqual(await kite.selectRow(db, kite.domains), (await kite.selectRows(db, kite.domains, undefined, 1))[0]);
	const decision = await kite.resolveInboundAddress(db, "nobody@pending.example.test");
	assert.equal(decision, null);
});

test("an insert that would lose a value in a missing column still fails", async (t) => {
	const env = await databaseWithout(t, "receiving_provider");
	const db = kite.createDb(env.DB);
	await assert.rejects(
		kite.insertRow(db, kite.domains, {
			id: "dom-1",
			userId: "user-1",
			hostname: "lost.example.test",
			zoneId: "manual",
			receivingProvider: "ses",
		}),
		(error) => /has no column named receiving_provider/.test(String(error.cause?.message ?? error.message)),
	);
	assert.deepEqual(await kite.listUserDomains(env, "user-1"), []);
});
