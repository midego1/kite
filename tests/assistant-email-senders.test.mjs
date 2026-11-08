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

// Spec §5.3's documented cap and the security review's attempt/rate limits; not imported from the module so the
// constants stay module-private.
const MAX_SENDER_ADDRESSES = 5;
const MAX_CODE_ATTEMPTS = 5;
const CODES_PER_USER_PER_HOUR = 5;
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
async function insertPending(database, { id, userId, address, code, expired = false, attempts = 0 }) {
	const codeHash = await hashSessionToken(code);
	const nowSeconds = Math.floor(Date.now() / 1000);
	const expiresAt = expired ? nowSeconds - 1 : nowSeconds + 30 * 60;
	database.db
		.prepare(
			"INSERT INTO assistant_sender_addresses (id, user_id, address, code_hash, code_expires_at, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		)
		.run(id, userId, address, codeHash, expiresAt, attempts, nowSeconds);
}

function auditActions(database, action) {
	return database.db.prepare("SELECT * FROM audit_logs WHERE action = ? ORDER BY created_at").all(action);
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

	// Audited once for the successful verify, and once for the wrong-code and not-this-user's-row attempts.
	assert.equal(auditActions(database, "assistant_email.sender_verified").length, 1);
	assert.equal(auditActions(database, "assistant_email.sender_verify_failed").length, 1);
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

test("a code allows only MAX_CODE_ATTEMPTS wrong guesses, even in parallel, then drops itself", async (t) => {
	const { database, env, db } = await setup(t);
	await insertPending(database, { id: "row-1", userId: "alice", address: "alice@phone.test", code: "123456" });

	// More parallel guesses than the limit allows: the atomic compare-and-set must still cap it at exactly
	// MAX_CODE_ATTEMPTS, never more, however the guesses interleave.
	const guesses = await Promise.all(
		Array.from({ length: MAX_CODE_ATTEMPTS + 3 }, () => verifySenderAddress(env, db, "alice", "row-1", "000000")),
	);
	assert.ok(guesses.every((result) => result === false));
	assert.equal(auditActions(database, "assistant_email.sender_verify_failed").length, MAX_CODE_ATTEMPTS);

	// The code is gone: even the right one no longer verifies, and a fresh code is needed.
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
	const result = await addSenderAddress(env, db, "alice", "shared@phone.test");
	assert.equal(result.ok, true);
	assert.equal((await listSenderAddresses(db, "alice")).length, MAX_SENDER_ADDRESSES);
});

test("an address on a domain of this install is refused outright, never silently", async (t) => {
	const { database, env, db } = await setup(t);
	database.db.exec(
		"INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('dom-1', 'bob', 'kite.example', 'zone-1', 'active', 1)",
	);
	const result = await addSenderAddress(env, db, "alice", "someone@kite.example");
	assert.equal(result.ok, false);
	assert.equal(result.code, "INSTALL_DOMAIN");
	assert.equal((await listSenderAddresses(db, "alice")).length, 0, "no row was ever created for it");

	// Even a pending domain (not yet active) is still refused: it is a domain of this install either way.
	database.db.exec("UPDATE domains SET status = 'pending' WHERE id = 'dom-1'");
	const pendingDomain = await addSenderAddress(env, db, "alice", "someone-else@kite.example");
	assert.equal(pendingDomain.ok, false);
	assert.equal(pendingDomain.code, "INSTALL_DOMAIN");
});

test("adding again after the code expires sends a fresh one instead of staying blocked forever", async (t) => {
	const { database, env, db } = await setup(t);
	await insertPending(database, {
		id: "row-1",
		userId: "alice",
		address: "alice@phone.test",
		code: "111111",
		expired: true,
	});
	const result = await addSenderAddress(env, db, "alice", "alice@phone.test");
	assert.equal(result.ok, true);
	const rows = await listSenderAddresses(db, "alice");
	assert.equal(rows.length, 1, "the stale row was replaced, not added alongside");
	// The expired row's own id is gone (a fresh one replaced it) and the old code no longer works on it.
	assert.equal(await verifySenderAddress(env, db, "alice", "row-1", "111111"), false);
	const refreshed = database.db
		.prepare("SELECT id, code_hash FROM assistant_sender_addresses WHERE address = ?")
		.get("alice@phone.test");
	assert.notEqual(refreshed.id, "row-1");
	assert.ok(refreshed.code_hash, "a fresh code was stored");
});

test("more than CODES_PER_USER_PER_HOUR code requests in an hour are refused, not silently dropped", async (t) => {
	const { database, env, db } = await setup(t);
	for (let i = 0; i < CODES_PER_USER_PER_HOUR; i += 1) {
		const result = await addSenderAddress(env, db, "alice", `alice-${i}@phone.test`);
		assert.equal(result.ok, true, `request ${i} should succeed`);
	}
	const limited = await addSenderAddress(env, db, "alice", "alice-over@phone.test");
	assert.equal(limited.ok, false);
	assert.equal(limited.code, "RATE_LIMITED");
	// Bob's own budget is untouched by Alice's requests.
	const bob = await addSenderAddress(env, db, "bob", "bob-1@phone.test");
	assert.equal(bob.ok, true);
});

test("removing only ever removes the caller's own row, and audits it", async (t) => {
	const { database, env, db } = await setup(t);
	await insertPending(database, { id: "row-1", userId: "alice", address: "alice@phone.test", code: "1" });
	await removeSenderAddress(env, db, "bob", "row-1");
	assert.equal((await listSenderAddresses(db, "alice")).length, 1, "bob cannot remove alice's row");
	assert.equal(auditActions(database, "assistant_email.sender_removed").length, 0);
	await removeSenderAddress(env, db, "alice", "row-1");
	assert.equal((await listSenderAddresses(db, "alice")).length, 0);
	assert.equal(auditActions(database, "assistant_email.sender_removed").length, 1);
});

test("before migration 0096, every operation reads or fails as pending, never throwing something else", async (t) => {
	const { database, env, db } = await setup(t);
	database.db.exec("DROP TABLE assistant_sender_addresses");

	assert.deepEqual(await listSenderAddresses(db, "alice"), []);
	await assert.rejects(() => addSenderAddress(env, db, "alice", "alice@phone.test"), SenderAddressesPendingError);
	await assert.rejects(() => verifySenderAddress(env, db, "alice", "row-1", "123456"), SenderAddressesPendingError);
	await assert.rejects(() => removeSenderAddress(env, db, "alice", "row-1"), SenderAddressesPendingError);
});

test("before migration 0097, the table exists but attempts does not: the same pending behaviour applies", async (t) => {
	const { database, env, db } = await setup(t);
	await insertPending(database, { id: "row-1", userId: "alice", address: "alice@phone.test", code: "123456" });
	database.db.exec("ALTER TABLE assistant_sender_addresses DROP COLUMN attempts");

	// Reading still works (selectRows retries without the missing column, reading attempts as its default).
	const rows = await listSenderAddresses(db, "alice");
	assert.equal(rows.length, 1);
	// Verifying needs to update attempts atomically, which it cannot do yet.
	await assert.rejects(() => verifySenderAddress(env, db, "alice", "row-1", "123456"), SenderAddressesPendingError);
});
