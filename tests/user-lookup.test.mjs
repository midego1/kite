import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-user-lookup-bundle-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createSession, getUserFromSession } from "./src/lib/auth/session.ts";
			export { missingColumnFromError } from "./src/lib/auth/user-lookup-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "user-lookup-entry.ts",
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
const { SqliteDatabase, applyMigrations, createSession, getUserFromSession, missingColumnFromError } = await import(
	pathToFileURL(join(bundleDirectory, "entry.mjs")).href
);

test("missingColumnFromError reads D1, SQLite and wrapped errors", () => {
	assert.equal(
		missingColumnFromError(new Error("D1_ERROR: no such column: agent_max_steps at offset 120: SQLITE_ERROR")),
		"agent_max_steps",
	);
	assert.equal(missingColumnFromError(new Error('no such column: "users"."undo_send_seconds"')), "undo_send_seconds");
	assert.equal(
		missingColumnFromError(new Error("Failed query", { cause: new Error("no such column: agent_max_steps") })),
		"agent_max_steps",
	);
	assert.equal(missingColumnFromError(new Error("UNIQUE constraint failed: users.email")), null);
});

test("a session still resolves before a new users column is migrated", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "kite-user-lookup-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const database = new SqliteDatabase(join(directory, "kite.sqlite"));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle", "migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('user-1', 'owner@example.com', 'hash', 'Owner', 1);
		ALTER TABLE users DROP COLUMN agent_max_steps;
	`);
	const env = { DB: database };
	const token = await createSession(env, "user-1");
	const user = await getUserFromSession(env, token);
	assert.equal(user?.id, "user-1");
	assert.equal(user?.email, "owner@example.com");
	assert.equal(user?.agentMaxSteps, 15);
});
