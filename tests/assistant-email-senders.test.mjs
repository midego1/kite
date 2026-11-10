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

// A second bundle whose `sendSystemEmail` always throws, for the one test that needs a real delivery failure
// (not the usual "no domain can send" false) to prove the row it minted is cleaned up, not left to block a retry.
const throwingOutDir = makeBundleDirectory("kite-assistant-email-senders-throwing-");
after(() => rmSync(throwingOutDir, { recursive: true, force: true }));
const stubThrowingSystemMail = {
	name: "stub-throwing-system-mail",
	setup(build) {
		build.onResolve({ filter: /^@\/lib\/email\/system-mail$/ }, (args) => ({ path: args.path, namespace: "stub" }));
		build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
			contents: "export async function sendSystemEmail() { throw new Error('simulated send failure'); }",
			loader: "js",
		}));
	},
};
await build({
	entryPoints: { senderAddresses: join(root, "src/lib/agent/email/sender-addresses.ts") },
	outdir: throwingOutDir,
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
	plugins: [stubThrowingSystemMail],
	alias: { "cloudflare:workers": join(root, "server/runtime/cloudflare-workers.ts") },
});
const { addSenderAddress: addSenderAddressThrowing } = await import(
	pathToFileURL(join(throwingOutDir, "senderAddresses.mjs")).href
);

// Spec §5.3's documented cap and the security review's attempt/rate limits; not imported from the module so the
// constants stay module-private.
const MAX_SENDER_ADDRESSES = 5;
const MAX_CODE_ATTEMPTS = 5;
const CODES_PER_USER_PER_HOUR = 5;
const CODES_PER_ADDRESS_PER_HOUR = 3;
const MAX_FAILED_CODES_PER_DAY = 10;
const GLOBAL_CODES_PER_ADDRESS_PER_DAY = 50;
const GLOBAL_FAILED_CODES_PER_ADDRESS_PER_DAY = 50;
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

test("two parallel guesses of the same correct code verify the address exactly once (security review should-fix)", async (t) => {
	const { database, env, db } = await setup(t);
	await insertPending(database, { id: "row-1", userId: "alice", address: "alice@phone.test", code: "123456" });

	const results = await Promise.all([
		verifySenderAddress(env, db, "alice", "row-1", "123456"),
		verifySenderAddress(env, db, "alice", "row-1", "123456"),
	]);
	assert.equal(results.filter(Boolean).length, 1, "exactly one of the two concurrent correct guesses succeeds");
	assert.equal(auditActions(database, "assistant_email.sender_verified").length, 1, "audited once, not twice");
	const [row] = await listSenderAddresses(db, "alice");
	assert.equal(row.verified, true);
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
	const { env, db } = await setup(t);
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

test("a burst of parallel adds never lets concurrent requests past the per-user cap or the address cap (security review blocker a)", async (t) => {
	const { database, env, db } = await setup(t);
	// More parallel requests than either cap allows, each for its own brand-new address: without the atomic
	// INSERT ... SELECT ... WHERE, every one of these would read "under the cap" before any of them committed.
	const addresses = Array.from({ length: CODES_PER_USER_PER_HOUR + 5 }, (_, i) => `burst-${i}@phone.test`);
	const results = await Promise.all(addresses.map((address) => addSenderAddress(env, db, "alice", address)));
	assert.equal(
		results.filter((result) => result.ok).length,
		CODES_PER_USER_PER_HOUR,
		"exactly the per-user cap of requests succeeded; the rest were refused as RATE_LIMITED, not silently dropped",
	);
	assert.ok(results.every((result) => result.ok || result.code === "RATE_LIMITED"));
	assert.equal(
		auditActions(database, "assistant_email.sender_code_requested").length,
		CODES_PER_USER_PER_HOUR,
		"exactly the per-user cap of code mails were reserved, not more",
	);
	assert.equal(
		(await listSenderAddresses(db, "alice")).length,
		CODES_PER_USER_PER_HOUR,
		"exactly the per-user cap of rows were created, not more",
	);
});

test("two users adding the same brand-new address in parallel: exactly one row is created, neither call throws", async (t) => {
	const { database, env, db } = await setup(t);
	const [aliceResult, bobResult] = await Promise.all([
		addSenderAddress(env, db, "alice", "contested@phone.test"),
		addSenderAddress(env, db, "bob", "contested@phone.test"),
	]);
	assert.equal(aliceResult.ok, true);
	assert.equal(bobResult.ok, true);
	const rows = database.db
		.prepare("SELECT user_id FROM assistant_sender_addresses WHERE address = ?")
		.all("contested@phone.test");
	assert.equal(rows.length, 1, "only one of the two ever got a row, never both and never neither");
});

test("a code exhausted by wrong guesses frees the address for a different user, not just the same one (security review blocker b)", async (t) => {
	const { database, env, db } = await setup(t);
	await insertPending(database, { id: "row-1", userId: "alice", address: "exhausted@phone.test", code: "123456" });

	// Exhaust alice's code with wrong guesses, same as the dedicated attempts test above.
	await Promise.all(
		Array.from({ length: MAX_CODE_ATTEMPTS + 2 }, () => verifySenderAddress(env, db, "alice", "row-1", "000000")),
	);
	const exhausted = database.db.prepare("SELECT code_hash FROM assistant_sender_addresses WHERE id = ?").get("row-1");
	assert.equal(exhausted.code_hash, null, "the code is gone once its attempts are used up");

	// Bob asking for the same address must not be blocked by alice's dead row forever.
	const bobResult = await addSenderAddress(env, db, "bob", "exhausted@phone.test");
	assert.equal(bobResult.ok, true);
	const rows = database.db
		.prepare("SELECT id, user_id, code_hash FROM assistant_sender_addresses WHERE address = ?")
		.all("exhausted@phone.test");
	assert.equal(rows.length, 1, "alice's exhausted row was replaced, not kept alongside bob's");
	assert.equal(rows[0].user_id, "bob");
	assert.ok(rows[0].code_hash, "bob got a fresh code");
	assert.notEqual(rows[0].id, "row-1");
});

test("a code exhausted by wrong guesses also frees the address for the same user to try again", async (t) => {
	const { database, env, db } = await setup(t);
	await insertPending(database, { id: "row-1", userId: "alice", address: "retry@phone.test", code: "123456" });
	await Promise.all(
		Array.from({ length: MAX_CODE_ATTEMPTS + 2 }, () => verifySenderAddress(env, db, "alice", "row-1", "000000")),
	);
	const result = await addSenderAddress(env, db, "alice", "retry@phone.test");
	assert.equal(result.ok, true);
	const rows = await listSenderAddresses(db, "alice");
	assert.equal(rows.length, 1);
	assert.notEqual(rows[0].id, "row-1");
});

function seedAudit(database, action, address, actors, extra = {}) {
	const nowSeconds = Math.floor(Date.now() / 1000);
	const user = database.db.prepare(
		"INSERT OR IGNORE INTO users (id, email, password_hash, name, created_at) VALUES (?, ?, 'hash', ?, 1)",
	);
	for (const actor of new Set(actors)) user.run(actor, `${actor}@example.com`, actor);
	const insert = database.db.prepare(
		"INSERT INTO audit_logs (id, actor_user_id, action, metadata, created_at) VALUES (?, ?, ?, ?, ?)",
	);
	actors.forEach((actor, index) =>
		insert.run(
			`seed-${action}-${address}-${index}-${Object.keys(extra).join("")}`,
			actor,
			action,
			JSON.stringify({ address, ...extra }),
			nowSeconds,
		),
	);
}

const codeRows = (database, address) =>
	database.db.prepare("SELECT * FROM assistant_sender_addresses WHERE address = ?").all(address);

test("more than CODES_PER_ADDRESS requests for an address by one user in an hour are refused, other users still get a code", async (t) => {
	const { database, env, db } = await setup(t);
	// Alice's three requests this hour were all for this address, and none of them left a row (the address is free).
	seedAudit(
		database,
		"assistant_email.sender_code_requested",
		"popular@phone.test",
		Array.from({ length: CODES_PER_ADDRESS_PER_HOUR }, () => "alice"),
	);
	const limited = await addSenderAddress(env, db, "alice", "popular@phone.test");
	assert.equal(limited.ok, false);
	assert.equal(limited.code, "RATE_LIMITED");
	assert.equal(codeRows(database, "popular@phone.test").length, 0);
	// Bob is not held back by alice's requests: he gets a real code row for the same address.
	assert.equal((await addSenderAddress(env, db, "bob", "popular@phone.test")).ok, true);
	const [row] = codeRows(database, "popular@phone.test");
	assert.equal(row?.user_id, "bob");
	assert.ok(row.code_hash, "a code was minted for bob");
});

test("a crowd of users minting codes for one address hits the global daily cap", async (t) => {
	const { database, env, db } = await setup(t);
	seedAudit(
		database,
		"assistant_email.sender_code_requested",
		"flooded@phone.test",
		Array.from({ length: GLOBAL_CODES_PER_ADDRESS_PER_DAY }, (_, i) => `spammer-${i}`),
	);
	const limited = await addSenderAddress(env, db, "alice", "flooded@phone.test");
	assert.equal(limited.ok, false);
	assert.equal(limited.code, "RATE_LIMITED");
	assert.equal((await addSenderAddress(env, db, "alice", "elsewhere@phone.test")).ok, true);
});

test("requests that mailed no code do not count toward the global cap", async (t) => {
	const { database, env, db } = await setup(t);
	seedAudit(
		database,
		"assistant_email.sender_code_requested",
		"held@phone.test",
		Array.from({ length: GLOBAL_CODES_PER_ADDRESS_PER_DAY }, (_, i) => `colluder-${i}`),
		{ unminted: true },
	);
	assert.equal((await addSenderAddress(env, db, "alice", "held@phone.test")).ok, true);
	assert.equal(codeRows(database, "held@phone.test").length, 1);
});

test("codes their requester removed again do not count toward the global cap, so mint-remove cycles cannot fill it", async (t) => {
	const { database, env, db } = await setup(t);
	// Alice mints and removes the same address over and over; her own per-address caps stop her, so seed the rest.
	await addSenderAddress(env, db, "alice", "cycled@phone.test");
	const [row] = codeRows(database, "cycled@phone.test");
	await removeSenderAddress(env, db, "alice", row.id);
	const [request] = auditActions(database, "assistant_email.sender_code_requested");
	assert.equal(JSON.parse(request.metadata).unminted, true, "the removed code no longer counts");
	assert.equal(JSON.parse(request.metadata).address, "cycled@phone.test");
	seedAudit(
		database,
		"assistant_email.sender_code_requested",
		"cycled@phone.test",
		Array.from({ length: GLOBAL_CODES_PER_ADDRESS_PER_DAY - 1 }, (_, i) => `other-${i}`),
	);
	// 49 standing codes by others and one removed one: still under the global cap, so a new user gets a code.
	assert.equal((await addSenderAddress(env, db, "bob", "cycled@phone.test")).ok, true);
	assert.equal(codeRows(database, "cycled@phone.test")[0]?.user_id, "bob");
});

test("a request that hits someone else's pending row is marked as having mailed no code, but still counts for the requester", async (t) => {
	const { database, env, db } = await setup(t);
	await insertPending(database, { id: "alice-row", userId: "alice", address: "held@phone.test", code: "123456" });
	assert.equal((await addSenderAddress(env, db, "bob", "held@phone.test")).ok, true);
	const [request] = auditActions(database, "assistant_email.sender_code_requested");
	assert.equal(request.actor_user_id, "bob");
	assert.equal(JSON.parse(request.metadata).unminted, true);
	assert.equal(codeRows(database, "held@phone.test").length, 1, "alice's row is untouched, no row for bob");
	// It still counts in bob's own budget: the answer never says whether the address is free.
	await addSenderAddress(env, db, "bob", "held@phone.test");
	await addSenderAddress(env, db, "bob", "held@phone.test");
	assert.equal((await addSenderAddress(env, db, "bob", "held@phone.test")).code, "RATE_LIMITED");
});

test("one user's wrong guesses do not stop another user's code request for the same address", async (t) => {
	const { database, env, db } = await setup(t);
	seedAudit(
		database,
		"assistant_email.sender_verify_failed",
		"shared@phone.test",
		Array.from({ length: MAX_FAILED_CODES_PER_DAY }, () => "alice"),
	);
	const refused = await addSenderAddress(env, db, "alice", "shared@phone.test");
	assert.equal(refused.ok, false);
	assert.equal(refused.code, "RATE_LIMITED");
	assert.equal((await addSenderAddress(env, db, "bob", "shared@phone.test")).ok, true);
	assert.equal(codeRows(database, "shared@phone.test")[0]?.user_id, "bob", "bob got a code row");
	// Verification itself is also counted per user: bob's pending row is not blocked by alice's failures.
	await insertPending(database, { id: "bob-row", userId: "bob", address: "bob-shared@phone.test", code: "123456" });
	seedAudit(
		database,
		"assistant_email.sender_verify_failed",
		"bob-shared@phone.test",
		Array.from({ length: MAX_FAILED_CODES_PER_DAY - 1 }, () => "alice"),
	);
	assert.equal(await verifySenderAddress(env, db, "bob", "bob-row", "123456"), true);
});

test("a crowd of wrong guesses at one address hits the global cap only for users who guessed wrong themselves", async (t) => {
	const { database, env, db } = await setup(t);
	seedAudit(
		database,
		"assistant_email.sender_verify_failed",
		"guessed@phone.test",
		Array.from({ length: GLOBAL_FAILED_CODES_PER_ADDRESS_PER_DAY }, (_, i) => `guesser-${i}`),
	);
	// Bob has a clean record on this address: the crowd does not stop him.
	assert.equal((await addSenderAddress(env, db, "bob", "guessed@phone.test")).ok, true);
	assert.equal(codeRows(database, "guessed@phone.test")[0]?.user_id, "bob");
	seedAudit(database, "assistant_email.sender_verify_failed", "guessed@phone.test", ["guesser-0"], { again: 1 });
	const refused = await addSenderAddress(env, db, "guesser-0", "guessed@phone.test");
	assert.equal(refused.ok, false);
	assert.equal(refused.code, "RATE_LIMITED");
});

test("an address with MAX_FAILED_CODES_PER_DAY failed guesses across its codes refuses new codes until tomorrow", async (t) => {
	const { database, env, db } = await setup(t);
	await insertPending(database, { id: "row-1", userId: "alice", address: "bruteforced@phone.test", code: "111111" });
	await Promise.all(
		Array.from({ length: MAX_CODE_ATTEMPTS }, () => verifySenderAddress(env, db, "alice", "row-1", "000000")),
	);
	assert.equal(auditActions(database, "assistant_email.sender_verify_failed").length, MAX_CODE_ATTEMPTS);

	// Only half of the daily cap is spent: a fresh code is still sent, exactly as the dedicated expiry test shows.
	const refreshed = await addSenderAddress(env, db, "alice", "bruteforced@phone.test");
	assert.equal(refreshed.ok, true);
	const row2 = database.db
		.prepare("SELECT id FROM assistant_sender_addresses WHERE address = ?")
		.get("bruteforced@phone.test");
	assert.notEqual(row2.id, "row-1");

	// Exhaust the second code too: the day's total is now MAX_FAILED_CODES_PER_DAY.
	await Promise.all(
		Array.from({ length: MAX_CODE_ATTEMPTS }, () => verifySenderAddress(env, db, "alice", row2.id, "000000")),
	);
	assert.equal(auditActions(database, "assistant_email.sender_verify_failed").length, MAX_FAILED_CODES_PER_DAY);

	// A third code is refused outright for the rest of the day, even though no code is currently pending for it.
	const refused = await addSenderAddress(env, db, "alice", "bruteforced@phone.test");
	assert.equal(refused.ok, false);
	assert.equal(refused.code, "RATE_LIMITED");
});

test("a real database error is not swallowed as 'the code was sent' (security review should-fix)", async (t) => {
	const { env, db } = await setup(t);
	// A user id with no row in `users` trips the foreign key constraint on insert — a genuine failure that must
	// propagate, unlike the unique-constraint conflict of someone else already holding the address.
	await assert.rejects(() => addSenderAddress(env, db, "ghost", "alice@phone.test"));
});

test("a delivery failure does not leave a row nobody can ever enter the code for (security review should-fix)", async (t) => {
	const { database, env, db } = await setup(t);
	const result = await addSenderAddressThrowing(env, db, "alice", "undeliverable@phone.test");
	assert.equal(result.ok, true, "still the generic success response: nothing about delivery is ever exposed");
	assert.equal(
		database.db.prepare("SELECT count(*) AS n FROM assistant_sender_addresses").get().n,
		0,
		"the row that could never be verified was cleaned up, not left to block a retry",
	);
	// A retry right away gets a fresh row instead of hitting a conflict with the dead one.
	const retried = await addSenderAddress(env, db, "alice", "undeliverable@phone.test");
	assert.equal(retried.ok, true);
	assert.equal((await listSenderAddresses(db, "alice")).length, 1);
});

test("addSenderAddress can replace a user's own expired address even while already at MAX_SENDER_ADDRESSES", async (t) => {
	const { database, env, db } = await setup(t);
	for (let i = 0; i < MAX_SENDER_ADDRESSES - 1; i += 1) {
		await insertPending(database, { id: `row-${i}`, userId: "alice", address: `alice-${i}@phone.test`, code: "1" });
	}
	await insertPending(database, {
		id: "row-expired",
		userId: "alice",
		address: "alice-expired@phone.test",
		code: "123456",
		expired: true,
	});
	assert.equal((await listSenderAddresses(db, "alice")).length, MAX_SENDER_ADDRESSES, "set up right at the cap");

	// Re-adding the one expired address replaces it, even though the user is at the cap: the stale row for this
	// exact address is freed before the cap is checked, so this is not the same as adding a sixth address.
	const result = await addSenderAddress(env, db, "alice", "alice-expired@phone.test");
	assert.equal(result.ok, true);
	const rows = await listSenderAddresses(db, "alice");
	assert.equal(rows.length, MAX_SENDER_ADDRESSES, "still at the cap, not over it");
	const replaced = rows.find((row) => row.address === "alice-expired@phone.test");
	assert.ok(replaced);
	assert.notEqual(replaced.id, "row-expired");
});

test("no code is sent, and nothing is audited, before migration 0103 is applied", async (t) => {
	const { database, env, db } = await setup(t);
	database.db.exec("ALTER TABLE assistant_sender_addresses DROP COLUMN attempts");
	await assert.rejects(() => addSenderAddress(env, db, "alice", "alice@phone.test"), SenderAddressesPendingError);
	assert.equal(auditActions(database, "assistant_email.sender_code_requested").length, 0);
	assert.equal(database.db.prepare("SELECT count(*) AS n FROM assistant_sender_addresses").get().n, 0);
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

test("before migration 0103, the table exists but attempts does not: the same pending behaviour applies", async (t) => {
	const { database, env, db } = await setup(t);
	await insertPending(database, { id: "row-1", userId: "alice", address: "alice@phone.test", code: "123456" });
	database.db.exec("ALTER TABLE assistant_sender_addresses DROP COLUMN attempts");

	// Reading still works (selectRows retries without the missing column, reading attempts as its default).
	const rows = await listSenderAddresses(db, "alice");
	assert.equal(rows.length, 1);
	// Verifying needs to update attempts atomically, which it cannot do yet.
	await assert.rejects(() => verifySenderAddress(env, db, "alice", "row-1", "123456"), SenderAddressesPendingError);
});
