import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

// Invented addresses only.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-assistant-email-senders-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		senderAddresses: join(root, "src/lib/agent/email/sender-addresses.ts"),
		db: join(root, "src/db/index.ts"),
		runtime: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
		session: join(root, "src/lib/auth/session.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	splitting: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	packages: "external",
	tsconfig: join(root, "tsconfig.json"),
	alias: { "cloudflare:workers": join(root, "server/runtime/cloudflare-workers.ts") },
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { addSenderAddress, listSenderAddresses, removeSenderAddress, verifySenderAddress, SenderAddressesPendingError } =
	await load("senderAddresses");

// Spec §5.3's documented cap; not imported from the module so the constant stays module-private.
const MAX_SENDER_ADDRESSES = 5;
const { getDb } = await load("db");
const { SqliteDatabase } = await load("runtime");
const { applyMigrations } = await load("migrate");
const { hashSessionToken } = await load("session");

async function setup(t) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('alice', 'alice@example.com', 'hash', 'Alice', 1);
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('bob', 'bob@example.com', 'hash', 'Bob', 1);
	`);
	const env = { DB: database };
	globalThis.__kiteNodeEnv = env;
	t.after(() => delete globalThis.__kiteNodeEnv);
	return { database, env, db: getDb(env) };
}

// `code_expires_at`/`created_at` are drizzle `timestamp` columns, stored as unix seconds (not milliseconds).
async function insertPending(database, { id, userId, address, code, expired = false }) {
	const codeHash = await hashSessionToken(code);
	const nowSeconds = Math.floor(Date.now() / 1000);
	const expiresAt = expired ? nowSeconds - 1 : nowSeconds + 30 * 60;
	database.db
		.prepare(
			"INSERT INTO assistant_sender_addresses (id, user_id, address, code_hash, code_expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
		)
		.run(id, userId, address, codeHash, expiresAt, nowSeconds);
}

test("a verified address maps for the owner; an unverified or wrong code does not verify", async (t) => {
	const { database, env, db } = await setup(t);
	await insertPending(database, { id: "row-1", userId: "alice", address: "alice@phone.test", code: "123456" });

	assert.equal(await verifySenderAddress(env, db, "alice", "row-1", "000000"), false);
	assert.equal(await verifySenderAddress(env, db, "bob", "row-1", "123456"), false, "not this user's row");
	assert.equal(await verifySenderAddress(env, db, "alice", "row-1", "123456"), true);

	const [row] = await listSenderAddresses(db, "alice");
	assert.equal(row.address, "alice@phone.test");
	assert.equal(row.verified, true);

	// A second verify attempt (code already cleared) fails closed rather than succeeding again.
	assert.equal(await verifySenderAddress(env, db, "alice", "row-1", "123456"), false);
});

test("an expired code does not verify", async (t) => {
	const { database, env, db } = await setup(t);
	await insertPending(database, {
		id: "row-1",
		userId: "alice",
		address: "alice@phone.test",
		code: "123456",
		expired: true,
	});
	assert.equal(await verifySenderAddress(env, db, "alice", "row-1", "123456"), false);
});

test("adding stops at the per-user cap and never throws for someone else's address", async (t) => {
	const { database, env, db } = await setup(t);
	for (let i = 0; i < MAX_SENDER_ADDRESSES; i += 1) {
		await insertPending(database, { id: `row-${i}`, userId: "alice", address: `alice-${i}@phone.test`, code: "1" });
	}
	await addSenderAddress(env, db, "alice", "alice-new@phone.test");
	assert.equal((await listSenderAddresses(db, "alice")).length, MAX_SENDER_ADDRESSES, "the cap was not exceeded");

	await insertPending(database, { id: "bobs", userId: "bob", address: "shared@phone.test", code: "1" });
	// Someone else's address: addSenderAddress must not throw, and must not create a second row for it.
	await assert.doesNotReject(() => addSenderAddress(env, db, "alice", "shared@phone.test"));
	assert.equal((await listSenderAddresses(db, "alice")).length, MAX_SENDER_ADDRESSES);
});

test("removing only ever removes the caller's own row", async (t) => {
	const { database, db } = await setup(t);
	await insertPending(database, { id: "row-1", userId: "alice", address: "alice@phone.test", code: "1" });
	await removeSenderAddress(db, "bob", "row-1");
	assert.equal((await listSenderAddresses(db, "alice")).length, 1, "bob cannot remove alice's row");
	await removeSenderAddress(db, "alice", "row-1");
	assert.equal((await listSenderAddresses(db, "alice")).length, 0);
});

test("before migration 0096, listing reads empty and adding throws the pending error", async (t) => {
	const { database, env, db } = await setup(t);
	database.db.exec("DROP TABLE assistant_sender_addresses");

	assert.deepEqual(await listSenderAddresses(db, "alice"), []);
	await assert.rejects(() => addSenderAddress(env, db, "alice", "alice@phone.test"), SenderAddressesPendingError);
});
