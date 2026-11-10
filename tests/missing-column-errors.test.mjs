import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { copyMigrationsBefore } from "./support/module-database.mjs";

/**
 * `missingColumnFromError` reads only what the database said: Drizzle's `Failed query` wrapper repeats the bound
 * values, and a value that reads "no such column: x" must not turn a real failure into a pending migration in the
 * callers that fall back on it (connected-account permissions, domain errors).
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-missing-column-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { missingColumnFromError } from "./src/lib/auth/user-lookup-utils.ts";
			export { readCanConnect } from "./src/lib/external-accounts/access.ts";
			export { getDomainProvisioningError } from "./src/lib/domains/errors.ts";
		`,
		resolveDir: root,
		sourcefile: "missing-column-entry.ts",
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
const m = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);
const migrationsDir = join(root, "drizzle/migrations");

/** What Drizzle throws around a failed statement (drizzle-orm's DrizzleQueryError). */
const wrapped = (params, cause) =>
	new Error(`Failed query: select "can_connect_accounts" from "users" where "users"."id" = ?\nparams: ${params}`, {
		cause,
	});

test("the wrapper's bound values never count as the database's own message", () => {
	const real = new Error("D1_ERROR: database is locked: SQLITE_BUSY");
	assert.equal(m.missingColumnFromError(wrapped("no such column: evil", real)), null);
	assert.equal(m.missingColumnFromError(wrapped("x has no column named evil", real)), null);
	assert.equal(m.missingColumnFromError(new Error("insert failed\nparams: no such column: evil")), null);
	// The database's own answer, on the cause, still counts.
	assert.equal(
		m.missingColumnFromError(wrapped("no such column: evil", new Error("no such column: can_connect_accounts"))),
		"can_connect_accounts",
	);
	assert.equal(m.missingColumnFromError(new Error("no such column: agent_max_steps")), "agent_max_steps");
});

async function database(t, dir = migrationsDir) {
	const db = new m.SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await m.applyMigrations(db, dir);
	return db;
}

test("readCanConnect: true before migration 0079, but a real failure is thrown even when a value reads like one", async (t) => {
	const before = await database(t, copyMigrationsBefore(bundleDirectory, 79));
	assert.equal(await m.readCanConnect({ DB: before }, "user-1"), true);

	const db = await database(t);
	db.db.exec(
		"INSERT INTO users (id, email, password_hash, name, can_connect_accounts, created_at) VALUES ('user-1', 'a@example.com', 'h', 'A', 0, 1)",
	);
	assert.equal(await m.readCanConnect({ DB: db }, "user-1"), false);
	// The user id is a bound value; the statement then fails for a reason that is no pending migration.
	const prepare = db.prepare.bind(db);
	db.prepare = (sql) => {
		const statement = prepare(sql);
		const failing = () => {
			throw new Error("D1_ERROR: database is locked: SQLITE_BUSY");
		};
		statement.all = failing;
		statement.raw = failing;
		statement.first = failing;
		statement.run = failing;
		statement.bind = () => statement;
		return statement;
	};
	await assert.rejects(m.readCanConnect({ DB: db }, "no such column: evil"), (error) => {
		assert.match(String(error.cause?.message ?? error.message), /database is locked/);
		return true;
	});
});

test("domain errors: a pending migration only when the database names a missing column", () => {
	const real = new Error("UNIQUE constraint failed: domains.hostname");
	const refused = m.getDomainProvisioningError(wrapped("no such column: evil", real), "Could not add the domain");
	assert.notEqual(refused.code, "MIGRATION_PENDING");
	const pending = m.getDomainProvisioningError(
		wrapped("example.com", new Error("table domains has no column named dns_skipped")),
		"Could not add the domain",
	);
	assert.equal(pending.code, "MIGRATION_PENDING");
	assert.equal(pending.status, 409);
});
