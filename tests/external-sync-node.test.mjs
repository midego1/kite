import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { sampleMessage, startFakeImap } from "./support/fake-imap.mjs";
import { root } from "./support/modules-bundle.mjs";
import { createTestCertificate } from "./support/test-certificate.mjs";

// Connected accounts, PR 7 (spec §6.3–§6.7, §9.3, §14): the cron claims due accounts, a run examines INBOX through the
// Node connector against the fake IMAP server, writes new mail to the Mail store and the inbound queue, and the
// inbound pipeline's external branch delivers it into the account's mailbox (flags, dedupe by Message-ID, spam with
// the preset's Authentication-Results, the Screener, webhooks, automatic reading). Errors become account states with
// backoff; refusals (switch off, permission, pause, mailbox access) stop sync; "Other" addresses claim nothing.

/** Automatic reading is a recorder here, as in tests/screener.test.mjs. */
const stubAgentSchedule = {
	name: "stub-agent-schedule",
	setup(build) {
		build.onResolve({ filter: /^@\/lib\/agent\/auto-read\/schedule$/ }, (args) => ({
			path: args.path,
			namespace: "stub",
		}));
		build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
			contents:
				"export async function scheduleAgentWork(_env, input) { (globalThis.__syncScheduled ??= []).push(input.sourceMessageId); }",
			loader: "js",
		}));
	},
};

const outDir = makeBundleDirectory("kite-external-sync-node-");
after(() => rmSync(outDir, { recursive: true, force: true }));
const exports = [
	["createTcpConnect", "server/runtime/tcp-connect.ts"],
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
	["hashPassword", "src/lib/auth/password.ts"],
	[
		"connectExternalAccount, updateExternalAccount, removeExternalAccount, retestExternalAccount, checkExternalAccountNow, listAccountsNeedingAttention, listExternalAccounts",
		"src/lib/external-accounts/service.ts",
	],
	["planExternalSync, syncExternalAccount", "src/lib/external-accounts/sync.ts"],
	["setInstallEnabled", "src/lib/external-accounts/settings.ts"],
	["setCanConnect", "src/lib/external-accounts/access.ts"],
	["processInboundMessage", "src/lib/email/inbound.ts"],
	["appendRecentErrors", "src/lib/external-accounts/recent-errors.ts"],
	["getDb", "src/db/index.ts"],
	["externalAccounts", "src/db/schema/external-accounts.ts"],
	["eq", "drizzle-orm"],
];
await build({
	stdin: {
		contents: exports
			.map(([names, file]) => `export { ${names} } from "${file.includes("/") ? `./${file}` : file}";`)
			.join("\n"),
		resolveDir: root,
		sourcefile: "external-sync-test-entry.ts",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	absWorkingDir: root,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	plugins: [stubAgentSchedule],
	logLevel: "silent",
});
const {
	createTcpConnect,
	SqliteDatabase,
	applyMigrations,
	hashPassword,
	connectExternalAccount,
	updateExternalAccount,
	removeExternalAccount,
	retestExternalAccount,
	checkExternalAccountNow,
	listAccountsNeedingAttention,
	listExternalAccounts,
	planExternalSync,
	syncExternalAccount,
	setInstallEnabled,
	setCanConnect,
	processInboundMessage,
	appendRecentErrors,
	getDb,
	externalAccounts,
	eq,
} = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

const HOST = "imap.kite.test";
const USER = "user@example.test";
const PASSWORD = "app-password";
const KITE_PASSWORD = "kite-password-1";
const KEY = "test-only-invented-encryption-key-0123456789abcdef";
const tls = createTestCertificate([HOST, "imap.gmail.com"]);
const owner = { id: "owner", role: "user", passwordHash: hashPassword(KITE_PASSWORD) };
const other = { id: "other", role: "user", passwordHash: hashPassword(KITE_PASSWORD) };
/** The jitter of the backoff, pinned to the middle. */
const steady = { random: () => 0.5 };

const previousEnv = globalThis.__kiteNodeEnv;
const realFetch = globalThis.fetch;
after(() => {
	globalThis.__kiteNodeEnv = previousEnv;
	globalThis.fetch = realFetch;
});
// A new contact looks up a Gravatar; nothing leaves the test.
globalThis.fetch = async () => new Response("", { status: 404 });

/** Today's IMAP INTERNALDATE, so `UID SEARCH SINCE` (two days back) finds the messages. */
function today() {
	const date = new Date();
	const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][
		date.getUTCMonth()
	];
	return `${String(date.getUTCDate()).padStart(2, "0")}-${month}-${date.getUTCFullYear()} 08:00:00 +0000`;
}

async function fake(t, options = {}) {
	const server = await startFakeImap({
		tls,
		implicitTls: true,
		authPlain: true,
		saslIr: true,
		users: { [USER]: PASSWORD, "me@gmail.com": PASSWORD },
		folders: { INBOX: [{ raw: sampleMessage(1), internalDate: today() }] },
		...options,
	});
	t.after(() => server.close());
	return server;
}

function memoryBucket() {
	const objects = new Map();
	return {
		objects,
		put: async (key, value) => {
			objects.set(key, Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value));
		},
		get: async (key) => {
			const body = objects.get(key);
			if (!body) return null;
			return {
				arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
				text: async () => body.toString("utf8"),
			};
		},
		head: async (key) => (objects.has(key) ? { key } : null),
		delete: async (keys) => {
			for (const key of [keys].flat()) objects.delete(key);
		},
	};
}

async function setup(t, server) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, join(root, "drizzle/migrations"));
	const hash = hashPassword(KITE_PASSWORD);
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('owner', 'owner@example.com', '${hash}', 'Owner', 1);
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('other', 'other@example.com', '${hash}', 'Other', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'a', 'shared', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mailbox-b', 'other', 'domain-1', 'b', 'personal', 1);
		INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES ('access-1', 'mailbox-a', 'other', 'full_access', 1);
	`);
	const connect = createTcpConnect({ ca: tls.cert, resolve: async () => ["127.0.0.1"], allowLoopback: true });
	const inbound = [];
	const agent = [];
	const bucket = memoryBucket();
	const env = {
		KITE_RUNTIME: "node",
		APP_ENCRYPTION_KEY: KEY,
		TCP_CONNECT: (address, options) => connect({ ...address, port: server.port }, options),
		DB: db,
		BUCKET: bucket,
		INBOUND_QUEUE: { send: async (message) => inbound.push(message) },
		OUTBOUND_QUEUE: { send: async () => undefined },
		AGENT_QUEUE: {
			send: async (message) => agent.push(message),
			sendBatch: async (messages) => agent.push(...[...messages].map((entry) => entry.body)),
		},
	};
	globalThis.__kiteNodeEnv = env;
	globalThis.__syncScheduled = [];
	const row = () => db.db.prepare("SELECT * FROM external_accounts").get();
	const synced = () =>
		db.db
			.prepare(
				"SELECT id, subject, status, read, starred, external_account_id, mailbox_id, raw_r2_key, thread_id, spam_signals FROM messages ORDER BY rowid",
			)
			.all();
	/** Delivers what the runs queued, as the inbound consumer would. */
	const deliver = async () => {
		for (const message of inbound.splice(0)) await processInboundMessage(env, message);
	};
	/** Makes the account due again and lets its lease and Check now window pass. */
	const due = () =>
		db.db.exec("UPDATE external_accounts SET next_sync_at = 0, lease_until = NULL, last_sync_at = NULL");
	return { db, env, inbound, agent, bucket, row, synced, deliver, due };
}

const connectBody = (overrides = {}) => ({
	address: USER,
	preset: "other",
	mailboxId: "mailbox-a",
	imap: { host: HOST, port: 993, security: "tls" },
	password: PASSWORD,
	kitePassword: KITE_PASSWORD,
	...overrides,
});

async function refusal(promise) {
	try {
		await promise;
	} catch (error) {
		return { status: error.status, code: error.code, message: error.message };
	}
	assert.fail("expected a refusal");
}

const auditActions = (db) =>
	db.db
		.prepare(
			"SELECT action, metadata FROM audit_logs WHERE action LIKE 'external_account.sync%' ORDER BY created_at, rowid",
		)
		.all();

test("new INBOX mail arrives once, with its source flags, in the account's mailbox; Kite never writes to the source", async (t) => {
	const server = await fake(t);
	const { db, env, inbound, agent, bucket, row, synced, deliver, due } = await setup(t, server);
	const account = await connectExternalAccount(env, owner, connectBody({ syncIntervalMinutes: 15 }));
	assert.equal(account.sync.intervalMinutes, 15);
	assert.equal(account.sync.nextSyncAt, null);

	// The cron claims the account (pushing next_sync_at past the lease) and queues one run.
	assert.equal(await planExternalSync(env), 1);
	assert.deepEqual(agent.splice(0), [{ kind: "accounts.sync", accountId: account.id }]);
	assert.ok(row().next_sync_at > Date.now() / 1000 + 600, "claimed until the lease runs out");
	assert.equal(await planExternalSync(env), 0, "a claimed account is not claimed twice");

	// Nothing arrived since connecting: one EXAMINE, nothing fetched (the message from before connecting stays out).
	assert.deepEqual(await syncExternalAccount(env, account.id), { delivered: 0, skipped: 0, more: false });
	assert.equal(inbound.length, 0);
	assert.ok(row().last_success_at);
	assert.equal(row().lease_until, null);
	const nextCheck = row().next_sync_at * 1000 - Date.now();
	assert.ok(nextCheck > 14 * 60_000 && nextCheck <= 15 * 60_000, "the next check follows the interval");

	server.addMessage("INBOX", { raw: sampleMessage(2, { subject: "Read already" }), flags: ["\\Seen", "\\Flagged"] });
	server.addMessage("INBOX", sampleMessage(3, { subject: "Brand new" }));
	due();
	assert.deepEqual(await syncExternalAccount(env, account.id), { delivered: 2, skipped: 0, more: false });
	assert.deepEqual(
		inbound.map((message) => [message.rawR2Key, message.to, message.source]),
		[
			[`external/${account.id}/1/2.eml`, USER, { kind: "external", accountId: account.id, read: true, starred: true }],
			[
				`external/${account.id}/1/3.eml`,
				USER,
				{ kind: "external", accountId: account.id, read: false, starred: false },
			],
		],
	);
	assert.ok(bucket.objects.has(`external/${account.id}/1/2.eml`));
	assert.equal(db.db.prepare("SELECT last_uid FROM external_account_folders").get().last_uid, 3);
	const replay = [...inbound];
	await deliver();
	const rows = synced();
	assert.deepEqual(
		rows.map((message) => [message.subject, message.status, message.read, message.starred, message.mailbox_id]),
		[
			["Read already", "received", 1, 1, "mailbox-a"],
			["Brand new", "received", 0, 0, "mailbox-a"],
		],
	);
	assert.ok(rows.every((message) => message.external_account_id === account.id));
	assert.equal(globalThis.__syncScheduled.length, 2, "automatic reading runs on synced mail");

	// A queue retry and a re-run of the same UIDs never store a second copy.
	inbound.push(...replay);
	await deliver();
	due();
	assert.deepEqual(await syncExternalAccount(env, account.id), { delivered: 0, skipped: 0, more: false });
	assert.equal(synced().length, 2);

	// The same Message-ID again (moved back into INBOX: a new UID) is dropped and its object removed.
	server.addMessage("INBOX", sampleMessage(4, { subject: "Moved back" }));
	const original = db.db.prepare("SELECT provider_message_id FROM messages WHERE subject = 'Brand new'").get();
	server.addMessage(
		"INBOX",
		sampleMessage(5, { subject: "Brand new (again)", messageId: original.provider_message_id }),
	);
	due();
	assert.equal((await syncExternalAccount(env, account.id)).delivered, 2);
	await deliver();
	assert.deepEqual(
		synced().map((message) => message.subject),
		["Read already", "Brand new", "Moved back"],
	);
	assert.equal(bucket.objects.has(`external/${account.id}/1/5.eml`), false);

	// Read-only: every command is a sign-in, EXAMINE, FETCH, SEARCH or LOGOUT; nothing is stored, moved or marked.
	const verbs = new Set(server.commands.map((command) => command.line.split(" ").slice(1, 3).join(" ").toUpperCase()));
	for (const verb of verbs)
		assert.match(verb, /^(CAPABILITY|AUTHENTICATE PLAIN|EXAMINE "INBOX"|UID FETCH|UID SEARCH|LOGOUT)/, verb);
	// Ranges are bounded by UIDNEXT: a run never asks for `n:*`.
	assert.ok(
		server.commands.some((command) => /UID FETCH 4:5 \(UID FLAGS INTERNALDATE RFC822\.SIZE\)/.test(command.line)),
	);
	assert.ok(!server.commands.some((command) => /UID FETCH \d+:\*/.test(command.line)));
});

test("synced mail goes through spam, the Screener and webhooks; only a Gmail account's own header counts", async (t) => {
	const server = await fake(t);
	const { db, env, synced, deliver, due } = await setup(t, server);
	const gmail = await connectExternalAccount(
		env,
		owner,
		connectBody({ address: "me@gmail.com", preset: "gmail", imap: undefined, mailboxId: "mailbox-b" }),
	).catch((error) => error);
	// mailbox-b is the other user's personal mailbox: the owner cannot deliver there.
	assert.equal(gmail.status, 404);
	const google = await connectExternalAccount(env, other, {
		address: "me@gmail.com",
		preset: "gmail",
		mailboxId: "mailbox-b",
		password: PASSWORD,
		kitePassword: KITE_PASSWORD,
	});
	const custom = await connectExternalAccount(env, owner, connectBody());
	db.db.exec(`
		INSERT INTO webhooks (id, user_id, url, secret, events, enabled, created_at)
		VALUES ('hook-1', 'other', 'https://hooks.example.test/x', 'whsec', '["message.inbound"]', 1, 1);
	`);

	const authenticated = [
		"Received: from mail.partner.test (mail.partner.test. [192.0.2.7]) by mx.google.com with ESMTPS id abc;",
		"Authentication-Results: mx.google.com; dkim=pass header.i=@partner.test; spf=pass smtp.mailfrom=a@partner.test; dmarc=pass header.from=partner.test",
		"Authentication-Results: evil.example; dmarc=fail",
		sampleMessage(10, { subject: "Signed", from: "a@partner.test" }),
	].join("\r\n");
	server.addMessage("INBOX", authenticated);
	due();
	assert.equal((await syncExternalAccount(env, google.id, steady)).delivered, 1);
	assert.equal((await syncExternalAccount(env, custom.id, steady)).delivered, 1);
	await deliver();
	const [first, second] = synced();
	const signals = (message) => JSON.parse(message.spam_signals ?? "[]").map((signal) => signal.id);
	const fromGoogle = first.mailbox_id === "mailbox-b" ? first : second;
	const fromCustom = first.mailbox_id === "mailbox-b" ? second : first;
	assert.ok(signals(fromGoogle).includes("dmarc_passed"), "Gmail's own topmost header counts");
	assert.ok(!signals(fromGoogle).includes("dmarc_failed"), "the sender's copy further down does not");
	assert.ok(!signals(fromCustom).some((id) => /dmarc|dkim|spf/.test(id)), "a custom host's header never counts");
	// The webhook payload says where the message came from.
	const delivery = db.db.prepare("SELECT payload FROM webhook_deliveries").get();
	const payload = JSON.parse(delivery?.payload ?? "{}");
	assert.equal(payload.data?.source, "external");
	assert.equal(payload.data?.accountId, google.id);
});

test("the Screener holds an unknown sender's synced mail without a notification or automatic reading", async (t) => {
	const server = await fake(t);
	const { db, env, synced, deliver, due } = await setup(t, server);
	const account = await connectExternalAccount(env, owner, connectBody());
	db.db.exec(
		"INSERT INTO screener_settings (mailbox_id, enabled, mode, created_at, updated_at) VALUES ('mailbox-a', 1, 'screener', 1, 1)",
	);
	server.addMessage("INBOX", sampleMessage(20, { subject: "From a stranger", from: "stranger@unknown.test" }));
	due();
	await syncExternalAccount(env, account.id);
	await deliver();
	assert.deepEqual(
		synced().map((message) => [message.subject, message.status]),
		[["From a stranger", "screening"]],
	);
	assert.deepEqual(globalThis.__syncScheduled, []);
});

test("errors become states: a failed sign-in stops sync until reconnecting, throttling and outages back off", async (t) => {
	const server = await fake(t);
	const { db, env, agent, row, due } = await setup(t, server);
	const account = await connectExternalAccount(env, owner, connectBody());
	await syncExternalAccount(env, account.id);

	// Throttled: retry, 15 minutes first, and the account stays active.
	server.answerNextLogin("NO [THROTTLED] Too many simultaneous logins");
	due();
	assert.deepEqual(await syncExternalAccount(env, account.id, steady), { failed: "throttled" });
	let state = row();
	assert.deepEqual([state.status, state.status_reason, state.consecutive_failures], ["active", "throttled", 1]);
	assert.ok(Math.abs(state.next_sync_at * 1000 - Date.now() - 15 * 60_000) < 5_000);

	// Unreachable for a while: backoff doubles from the interval.
	server.refuseExamine("INBOX", "NO [UNAVAILABLE] Maintenance");
	due();
	assert.deepEqual(await syncExternalAccount(env, account.id, steady), { failed: "transient" });
	state = row();
	assert.deepEqual([state.status, state.status_reason, state.consecutive_failures], ["active", "transient", 2]);
	assert.ok(Math.abs(state.next_sync_at * 1000 - Date.now() - 20 * 60_000) < 5_000);
	assert.deepEqual((await listExternalAccounts(env, "owner"))[0].sync, {
		enabled: true,
		intervalMinutes: 5,
		lastSuccessAt: new Date(state.last_success_at * 1000).toISOString(),
		nextSyncAt: new Date(state.next_sync_at * 1000).toISOString(),
		failures: 2,
		problem: "transient",
		running: false,
	});

	// After a day of failing (three or more in a row): `error`, every 6 hours, and the notice lists it.
	db.db.exec(`UPDATE external_accounts SET last_success_at = ${Math.floor(Date.now() / 1000) - 2 * 86_400}`);
	due();
	await syncExternalAccount(env, account.id, steady);
	state = row();
	assert.deepEqual([state.status, state.consecutive_failures], ["error", 3]);
	assert.ok(Math.abs(state.next_sync_at * 1000 - Date.now() - 6 * 3_600_000) < 5_000);
	assert.deepEqual(
		(await listAccountsNeedingAttention(env, "owner")).map((entry) => entry.status),
		["error"],
	);

	// It works again: active, failures reset, recovered in the audit log.
	server.refuseExamine("INBOX", null);
	due();
	assert.equal((await syncExternalAccount(env, account.id, steady)).delivered, 0);
	state = row();
	assert.deepEqual(
		[state.status, state.status_reason, state.consecutive_failures, state.last_error],
		["active", null, 0, null],
	);

	// The password changed at the provider: sign-in failed, sync stops, the owner is told.
	server.setPassword(USER, "changed-at-provider");
	due();
	assert.deepEqual(await syncExternalAccount(env, account.id, steady), { failed: "auth" });
	state = row();
	assert.deepEqual([state.status, state.next_sync_at], ["auth_failed", null]);
	assert.doesNotMatch(state.last_error, /app-password|changed-at-provider/);
	assert.deepEqual(
		(await listAccountsNeedingAttention(env, "owner")).map((entry) => [entry.id, entry.status]),
		[[account.id, "auth_failed"]],
	);
	db.db.exec("UPDATE external_accounts SET next_sync_at = 0");
	assert.equal(await planExternalSync(env), 0, "a failed sign-in is never retried by itself");
	assert.equal((await refusal(checkExternalAccountNow(env, owner, account.id))).code, "RECONNECT_REQUIRED");
	agent.splice(0);

	// Reconnecting with the new password makes it active and due again.
	const reconnected = await updateExternalAccount(env, owner, account.id, {
		password: "changed-at-provider",
		kitePassword: KITE_PASSWORD,
	});
	assert.equal(reconnected.status, "active");
	assert.deepEqual(
		[row().next_sync_at, row().last_sync_at, row().consecutive_failures, row().status_reason],
		[null, null, 0, null],
		"due at once, and Check now works right after reconnecting",
	);
	assert.equal(await planExternalSync(env), 1);
	assert.equal((await retestExternalAccount(env, owner, account.id)).problem, null);

	// A missing INBOX is a configuration problem: `error`, and checking stops.
	server.refuseExamine("INBOX", "NO [NONEXISTENT] No such folder");
	due();
	assert.deepEqual(await syncExternalAccount(env, account.id, steady), { failed: "config" });
	state = row();
	assert.deepEqual([state.status, state.status_reason, state.next_sync_at], ["error", "config", null]);
	assert.equal(await planExternalSync(env), 0);

	const actions = auditActions(db);
	assert.deepEqual(
		actions.map((entry) => [entry.action, JSON.parse(entry.metadata).class ?? null]),
		[
			// The first failure and each new status are changes; a second failure while still active is not.
			["external_account.sync_failed", "throttled"],
			["external_account.sync_failed", "transient"],
			["external_account.sync_recovered", null],
			["external_account.sync_failed", "auth"],
			["external_account.sync_failed", "config"],
		],
	);
	for (const entry of actions) assert.doesNotMatch(entry.metadata, /example\.test|imap\.kite|Maintenance/);
});

test("a key that no longer opens the password stops sync as a failed sign-in", async (t) => {
	const server = await fake(t);
	const { env, row } = await setup(t, server);
	const account = await connectExternalAccount(env, owner, connectBody());
	const otherKey = { ...env, APP_ENCRYPTION_KEY: "another-invented-key-0123456789abcdefghijkl" };
	globalThis.__kiteNodeEnv = otherKey;
	assert.deepEqual(await syncExternalAccount(otherKey, account.id), { failed: "auth" });
	globalThis.__kiteNodeEnv = env;
	assert.equal(row().status, "auth_failed");
	assert.match(row().last_error, /can no longer be opened/);
});

test("nothing syncs while refused: install switch, permission, pause, a disabled owner or lost mailbox access", async (t) => {
	const server = await fake(t);
	const { db, env, agent, inbound, row, due, bucket } = await setup(t, server);
	const account = await connectExternalAccount(env, owner, connectBody());
	await syncExternalAccount(env, account.id);
	server.addMessage("INBOX", sampleMessage(30, { subject: "Waiting" }));
	const commands = () => server.commands.length;

	await setInstallEnabled(env, false);
	due();
	assert.equal(await planExternalSync(env), 0);
	let before = commands();
	assert.deepEqual(await syncExternalAccount(env, account.id), { skipped: "not_syncing" });
	assert.equal(commands(), before, "a suspended account never connects");
	await setInstallEnabled(env, true);

	await setCanConnect(env, "owner", false);
	due();
	assert.equal(await planExternalSync(env), 0);
	assert.deepEqual(await syncExternalAccount(env, account.id), { skipped: "not_syncing" });
	await setCanConnect(env, "owner", true);

	await updateExternalAccount(env, owner, account.id, { syncEnabled: false });
	due();
	assert.equal(await planExternalSync(env), 0);
	assert.equal((await refusal(checkExternalAccountNow(env, owner, account.id))).code, "SYNC_PAUSED");
	await updateExternalAccount(env, owner, account.id, { syncEnabled: true });
	assert.equal(row().next_sync_at, null, "resuming makes the check due at once");

	db.db.exec("UPDATE users SET disabled = 1 WHERE id = 'owner'");
	due();
	before = commands();
	assert.deepEqual(await syncExternalAccount(env, account.id), { skipped: "not_allowed" });
	assert.equal(commands(), before);
	assert.equal(row().lease_until, null, "the lease is given back");
	db.db.exec("UPDATE users SET disabled = 0 WHERE id = 'owner'");

	// Fetched, then refused before delivery: the message is not delivered and its object is removed.
	due();
	assert.equal((await syncExternalAccount(env, account.id)).delivered, 1);
	await setCanConnect(env, "owner", false);
	const [queued] = inbound.splice(0);
	await processInboundMessage(env, queued);
	assert.equal(db.db.prepare("SELECT count(*) AS n FROM messages").get().n, 0);
	assert.equal(bucket.objects.has(queued.rawR2Key), false);
	await setCanConnect(env, "owner", true);

	// The owner lost access to the mailbox: checking stops with a configuration problem.
	db.db.exec("UPDATE mailboxes SET user_id = 'other' WHERE id = 'mailbox-a'");
	due();
	assert.deepEqual(await syncExternalAccount(env, account.id), { failed: "config" });
	assert.match(row().last_error, /can no longer deliver/);
	assert.equal(agent.length, 0);
});

test("Check now queues one run at most once a minute, never beside a running one", async (t) => {
	const server = await fake(t);
	const { env, agent, row } = await setup(t, server);
	const account = await connectExternalAccount(env, owner, connectBody());
	const checked = await checkExternalAccountNow(env, owner, account.id);
	assert.equal(checked.id, account.id);
	assert.deepEqual(agent.splice(0), [{ kind: "accounts.sync", accountId: account.id }]);
	assert.equal((await refusal(checkExternalAccountNow(env, owner, account.id))).status, 429);
	assert.equal((await refusal(checkExternalAccountNow(env, other, account.id))).status, 404);
	assert.equal(await planExternalSync(env), 0, "the queued check is not planned again");
	assert.ok(row().last_sync_at);
	await syncExternalAccount(env, account.id);
	assert.equal(agent.length, 0);
	assert.equal((await refusal(checkExternalAccountNow(env, owner, account.id))).status, 429, "checked a moment ago");
	assert.deepEqual(await syncExternalAccount({ ...env, AGENT_QUEUE: undefined }, "missing"), { skipped: "removed" });
	assert.equal(await planExternalSync({ ...env, AGENT_QUEUE: undefined }), 0);
});

test("a rebuilt INBOX is checked again for two days and dedupe drops what Kite has; large messages are skipped", async (t) => {
	const server = await fake(t);
	const { db, env, synced, deliver, due, row } = await setup(t, server);
	const account = await connectExternalAccount(env, owner, connectBody());
	server.addMessage("INBOX", { raw: sampleMessage(40, { subject: "Before the reset" }), internalDate: today() });
	due();
	await syncExternalAccount(env, account.id);
	await deliver();
	assert.equal(synced().length, 1);

	server.bumpUidValidity("INBOX");
	server.addMessage("INBOX", { raw: sampleMessage(41, { subject: "After the reset" }), internalDate: today() });
	due();
	const result = await syncExternalAccount(env, account.id);
	// The two days hold the message from before connecting (never delivered), the one Kite has and the new one.
	assert.equal(result.delivered, 3);
	await deliver();
	assert.deepEqual(
		synced()
			.map((message) => message.subject)
			.sort(),
		["After the reset", "Before the reset", "Fake IMAP message 1"],
	);
	assert.equal(db.db.prepare("SELECT uidvalidity FROM external_account_folders").get().uidvalidity, 2);
	assert.match(row().recent_errors, /The provider reset the Inbox; Kite checked the last two days again/);

	server.addMessage("INBOX", { raw: sampleMessage(42, { subject: "Huge" }), size: 31 * 1024 * 1024 });
	server.addMessage("INBOX", sampleMessage(43, { subject: "Small after huge" }));
	due();
	assert.deepEqual(await syncExternalAccount(env, account.id), { delivered: 1, skipped: 1, more: false });
	await deliver();
	assert.ok(synced().some((message) => message.subject === "Small after huge"));
	assert.match(row().recent_errors, /Skipped a 31 MB message[^"]*: Kite receives messages up to 25 MB/);
	assert.equal(db.db.prepare("SELECT last_uid FROM external_account_folders").get().last_uid, 5);
});

test("more than one run's worth continues on a run queued right away; a run past its budget stops between chunks", async (t) => {
	const server = await fake(t);
	const { env, agent, inbound, row, due } = await setup(t, server);
	const account = await connectExternalAccount(env, owner, connectBody());
	for (let index = 0; index < 30; index += 1) server.addMessage("INBOX", sampleMessage(100 + index));
	due();
	// A run already past its budget stops before its first chunk and hands the rest to a run queued at once.
	assert.deepEqual(await syncExternalAccount(env, account.id, { budgetMs: -1 }), {
		delivered: 0,
		skipped: 0,
		more: true,
	});
	assert.deepEqual(agent.splice(0), [{ kind: "accounts.sync", accountId: account.id }]);
	assert.ok(row().next_sync_at * 1000 > Date.now() + 10 * 60_000, "the queued run, not the cron, continues");
	due();
	assert.deepEqual(await syncExternalAccount(env, account.id), { delivered: 30, skipped: 0, more: false });
	assert.equal(new Set(inbound.map((message) => message.rawR2Key)).size, 30);
});

test("removing an account keeps its synced mail and drops what was still queued", async (t) => {
	const server = await fake(t);
	const { db, env, inbound, bucket, synced, deliver, due } = await setup(t, server);
	const account = await connectExternalAccount(env, owner, connectBody());
	server.addMessage("INBOX", sampleMessage(50, { subject: "Kept" }));
	server.addMessage("INBOX", sampleMessage(51, { subject: "Still queued" }));
	due();
	await syncExternalAccount(env, account.id);
	await processInboundMessage(env, inbound.shift());
	await removeExternalAccount(env, owner, account.id);
	const [pending] = inbound.splice(0);
	await processInboundMessage(env, pending);
	await deliver();
	assert.deepEqual(
		synced().map((message) => [message.subject, message.external_account_id]),
		[["Kept", null]],
	);
	assert.equal(bucket.objects.has(pending.rawR2Key), false);
	assert.deepEqual(await syncExternalAccount(env, account.id), { skipped: "removed" });
	assert.equal(db.db.prepare("SELECT count(*) AS n FROM external_account_folders").get().n, 0);
});

test("an Other account's address proves nothing: it claims no slot and is never checked against others", async (t) => {
	const server = await fake(t, { users: { [USER]: PASSWORD, "me@gmail.com": PASSWORD } });
	const { db, env } = await setup(t, server);
	// Someone runs their own server and connects a Gmail address as "Other": allowed, but it claims nothing.
	const squatter = await connectExternalAccount(env, other, {
		...connectBody({ address: "me@gmail.com", mailboxId: "mailbox-b", username: "me@gmail.com" }),
	});
	// The real owner connects the same address with Gmail's own servers.
	const real = await connectExternalAccount(env, owner, {
		address: "me@gmail.com",
		preset: "gmail",
		mailboxId: "mailbox-a",
		password: PASSWORD,
		kitePassword: KITE_PASSWORD,
	});
	assert.notEqual(real.id, squatter.id);
	// A second "Other" connect of the same address is not told it is taken, so it cannot be used to probe.
	const second = await connectExternalAccount(
		env,
		owner,
		connectBody({ address: "me@gmail.com", username: "me@gmail.com" }),
	);
	assert.ok(second.id);
	// A proven address is still unique: a second Gmail connect, or turning an Other one into Gmail, is refused.
	assert.equal(
		(
			await refusal(
				connectExternalAccount(env, other, {
					address: "me@gmail.com",
					preset: "gmail",
					mailboxId: "mailbox-b",
					password: PASSWORD,
					kitePassword: KITE_PASSWORD,
				}),
			)
		).code,
		"ADDRESS_TAKEN",
	);
	assert.equal(
		(
			await refusal(
				updateExternalAccount(env, other, squatter.id, {
					preset: "gmail",
					password: PASSWORD,
					kitePassword: KITE_PASSWORD,
				}),
			)
		).code,
		"ADDRESS_TAKEN",
	);
	assert.equal(db.db.prepare("SELECT count(*) AS n FROM external_accounts WHERE address = 'me@gmail.com'").get().n, 3);
});

test("fetches stay under the connection's byte limit; a message the server will not send is skipped, not a blocker", async (t) => {
	const padded = (index, bytes) => sampleMessage(index, { subject: `Padded ${index}` }) + "x".repeat(bytes);
	const server = await fake(t, { folders: { INBOX: [] } });
	const { env, inbound, row, due, db } = await setup(t, server);
	const account = await connectExternalAccount(env, owner, connectBody());
	// Five ~1.2 KB messages under a 3 KB batch limit (2.7 KB planned): at most two per FETCH.
	for (let index = 1; index <= 5; index += 1) server.addMessage("INBOX", padded(index, 1000));
	// One the server refuses to send (Gmail: "Some messages could not be FETCHed"), between good ones.
	server.addMessage("INBOX", { raw: padded(6, 10), unfetchable: true });
	server.addMessage("INBOX", padded(7, 10));
	// No RFC822.SIZE, and larger than one literal may be: fetched alone, fails twice, skipped.
	server.addMessage("INBOX", { raw: padded(8, 6000), size: null });
	// Deleted at the provider between the summary and the body.
	server.addMessage("INBOX", { raw: padded(9, 10), vanishes: true });
	server.addMessage("INBOX", padded(10, 10));
	due();
	const commands = server.commands.length;
	const result = await syncExternalAccount(env, account.id, { limits: { fetchBatchBytes: 3000, literalBytes: 4000 } });
	assert.deepEqual(result, { delivered: 7, skipped: 3, more: false });
	const bodyFetches = server.commands
		.slice(commands)
		.map(
			(command) => /UID FETCH ([\d,]+) \(UID FLAGS INTERNALDATE RFC822\.SIZE BODY\.PEEK\[\]\)/.exec(command.line)?.[1],
		)
		.filter(Boolean);
	// 1.2 KB each: two fit under 2.7 KB, the small ones join the fifth; the refused FETCH is split into singles.
	assert.deepEqual(bodyFetches.slice(0, 4), ["1,2", "3,4", "5,6,7", "5"]);
	assert.ok(bodyFetches.includes("6") && bodyFetches.includes("8"), "the failing ones were tried alone");
	assert.deepEqual(
		inbound.map((message) => Number(message.rawR2Key.split("/").pop().replace(".eml", ""))),
		[1, 2, 3, 4, 5, 7, 10],
	);
	assert.equal(
		db.db.prepare("SELECT last_uid FROM external_account_folders").get().last_uid,
		10,
		"the cursor moved past all",
	);
	const notes = JSON.parse(row().recent_errors).map((entry) => entry.message);
	assert.equal(notes.filter((note) => /the server would not send/.test(note)).length, 2);
	assert.ok(notes.some((note) => /deleted at the provider before Kite fetched it/.test(note)));
	assert.equal(row().status, "active");
});

test("an empty INBOX without UIDNEXT is never asked for `1:*`", async (t) => {
	const server = await fake(t, { folders: { INBOX: [] }, omitUidNext: true, strictEmptyFetch: true });
	const { env, row, due } = await setup(t, server);
	const account = await connectExternalAccount(env, owner, connectBody());
	assert.deepEqual(await syncExternalAccount(env, account.id), { delivered: 0, skipped: 0, more: false });
	due();
	assert.deepEqual(await syncExternalAccount(env, account.id), { delivered: 0, skipped: 0, more: false });
	assert.ok(!server.commands.some((command) => /UID FETCH/.test(command.line)));
	assert.equal(row().consecutive_failures, 0);
	server.addMessage("INBOX", sampleMessage(1, { subject: "First" }));
	due();
	assert.equal((await syncExternalAccount(env, account.id)).delivered, 1);
});

test("dedupe trusts only this account, imports and Kite's own sends; a forged copy cannot hide the real message", async (t) => {
	const server = await fake(t);
	const { db, env, bucket, synced, deliver, due } = await setup(t, server);
	const account = await connectExternalAccount(env, owner, connectBody());
	// Someone sends the Kite address a copy carrying the Message-ID of a message about to arrive at the provider.
	const forged = sampleMessage(60, { subject: "Forged copy", messageId: "<real-60@example.org>" });
	await bucket.put("inbound/1-forged.eml", Buffer.from(forged));
	await processInboundMessage(env, { from: "x@evil.test", to: "a@example.com", rawR2Key: "inbound/1-forged.eml" });
	// An import of the same mailbox did bring in another message already.
	db.db
		.exec(`INSERT INTO messages (id, user_id, mailbox_id, direction, provider_message_id, from_addr, to_addr, subject, status, raw_r2_key, created_at)
		VALUES ('imported-1', 'owner', 'mailbox-a', 'inbound', '<imported-61@example.org>', 'a@b.test', 'user@example.test', 'Imported', 'received', 'imports/imported-1.eml', 1)`);
	server.addMessage("INBOX", sampleMessage(60, { subject: "Real message", messageId: "<real-60@example.org>" }));
	server.addMessage("INBOX", sampleMessage(61, { subject: "Imported again", messageId: "<imported-61@example.org>" }));
	due();
	await syncExternalAccount(env, account.id);
	await deliver();
	assert.deepEqual(
		synced()
			.map((message) => message.subject)
			.sort(),
		["Forged copy", "Imported", "Real message"],
	);
});

test("a run the platform stopped counts as a failure, backs off and shows", async (t) => {
	const server = await fake(t);
	const { db, env, row } = await setup(t, server);
	const account = await connectExternalAccount(env, owner, connectBody());
	// The last run took its lease and never gave it back.
	const past = Math.floor(Date.now() / 1000) - 60;
	db.db.exec(`UPDATE external_accounts SET lease_until = ${past}, next_sync_at = 0, last_sync_at = ${past - 900}`);
	const commands = server.commands.length;
	assert.deepEqual(await syncExternalAccount(env, account.id, steady), { failed: "transient" });
	assert.equal(server.commands.length, commands, "the run itself is not repeated at once");
	const state = row();
	assert.deepEqual([state.status, state.consecutive_failures, state.lease_until], ["active", 1, null]);
	assert.match(state.last_error, /did not finish/);
	assert.ok(state.next_sync_at * 1000 > Date.now() + 5 * 60_000, "backs off");
	db.db.exec("UPDATE external_accounts SET next_sync_at = 0");
	assert.equal((await syncExternalAccount(env, account.id, steady)).delivered, 0, "the next run runs");
	assert.equal(row().consecutive_failures, 0);
});

test("mail refused at delivery is fetched again once allowed; a last failed delivery is noted", async (t) => {
	const server = await fake(t);
	const { db, env, inbound, synced, deliver, due, row, bucket } = await setup(t, server);
	const account = await connectExternalAccount(env, owner, connectBody());
	server.addMessage("INBOX", sampleMessage(70, { subject: "Waiting 1" }));
	server.addMessage("INBOX", sampleMessage(71, { subject: "Waiting 2" }));
	due();
	assert.equal((await syncExternalAccount(env, account.id)).delivered, 2);
	await setCanConnect(env, "owner", false);
	await deliver();
	assert.equal(synced().length, 0);
	assert.equal(db.db.prepare("SELECT last_uid FROM external_account_folders").get().last_uid, 1, "moved back");
	await setCanConnect(env, "owner", true);
	due();
	assert.equal((await syncExternalAccount(env, account.id)).delivered, 2);
	await deliver();
	assert.deepEqual(
		synced().map((message) => message.subject),
		["Waiting 1", "Waiting 2"],
	);

	// A delivery that keeps failing: the queue's last attempt notes it on the account.
	server.addMessage("INBOX", sampleMessage(72, { subject: "Broken" }));
	due();
	await syncExternalAccount(env, account.id);
	const [queued] = inbound.splice(0);
	const realGet = bucket.get;
	bucket.get = async () => {
		throw new Error("store unavailable");
	};
	await assert.rejects(processInboundMessage(env, queued, { finalAttempt: false }));
	assert.doesNotMatch(row().recent_errors, /after several tries/);
	await assert.rejects(processInboundMessage(env, queued, { finalAttempt: true }));
	assert.match(row().recent_errors, /could not deliver a synced message after several tries/);
	bucket.get = realGet;
});

test("a run that lost its lease never moves the cursor", async (t) => {
	let release;
	const gate = new Promise((resolve) => (release = resolve));
	// FETCH 0 is the summary of the second run, 1 its bodies.
	const server = await fake(t, { fetchGate: (index) => (index === 1 ? gate : Promise.resolve()) });
	const { db, env, due, row } = await setup(t, server);
	const account = await connectExternalAccount(env, owner, connectBody());
	server.addMessage("INBOX", sampleMessage(80, { subject: "Slow" }));
	due();
	const running = syncExternalAccount(env, account.id);
	await new Promise((resolve) => {
		const timer = setInterval(() => {
			if (server.commands.filter((command) => /BODY\.PEEK/.test(command.line)).length) {
				clearInterval(timer);
				resolve();
			}
		}, 10);
	});
	// Another run took over meanwhile (the lease ran out).
	const takenOver = Math.floor(Date.now() / 1000) + 3600;
	db.db.exec(`UPDATE external_accounts SET lease_until = ${takenOver}`);
	release();
	await running;
	assert.equal(db.db.prepare("SELECT last_uid FROM external_account_folders").get().last_uid, 1, "unchanged");
	assert.equal(row().lease_until, takenOver, "the other run's lease stays");
});

test("synced mail in a shared mailbox belongs to the mailbox's owner, as received mail does", async (t) => {
	const server = await fake(t);
	const { db, env, deliver, due } = await setup(t, server);
	// "other" has full access to the shared mailbox-a, which "owner" owns.
	const account = await connectExternalAccount(env, other, connectBody());
	server.addMessage("INBOX", sampleMessage(90, { subject: "Shared" }));
	due();
	await syncExternalAccount(env, account.id);
	await deliver();
	const message = db.db.prepare("SELECT user_id, mailbox_id, external_account_id FROM messages").get();
	assert.deepEqual(message, { user_id: "owner", mailbox_id: "mailbox-a", external_account_id: account.id });
});

test("the planner never claims a disabled owner's accounts", async (t) => {
	const server = await fake(t);
	const { db, env, agent } = await setup(t, server);
	await connectExternalAccount(env, owner, connectBody());
	db.db.exec("UPDATE users SET disabled = 1 WHERE id = 'owner'");
	assert.equal(await planExternalSync(env), 0);
	db.db.exec("UPDATE users SET disabled = 0 WHERE id = 'owner'");
	assert.equal(await planExternalSync(env), 1);
	assert.equal(agent.length, 1);
});

test("recent problems are appended in the database: damaged lists reset, non-entries dropped, the last 20 kept", async (t) => {
	const server = await fake(t);
	const { db, env, row } = await setup(t, server);
	const account = await connectExternalAccount(env, owner, connectBody());
	const note = (messages) =>
		getDb(env)
			.update(externalAccounts)
			.set({ recentErrors: appendRecentErrors(messages, new Date("2026-10-29T10:00:00Z")) })
			.where(eq(externalAccounts.id, account.id));
	db.db.exec("UPDATE external_accounts SET recent_errors = 'not json'");
	await note(["first"]);
	assert.deepEqual(JSON.parse(row().recent_errors), [{ at: "2026-10-29T10:00:00.000Z", message: "first" }]);
	db.db.exec(`UPDATE external_accounts SET recent_errors = '{"a":1}'`);
	await note(["only"]);
	assert.equal(JSON.parse(row().recent_errors).length, 1);
	db.db.exec(`UPDATE external_accounts SET recent_errors = '[{"at":"x","message":"kept"},null,"dropped",3]'`);
	await note(["new"]);
	assert.deepEqual(
		JSON.parse(row().recent_errors).map((entry) => entry.message),
		["kept", "new"],
	);
	await note(Array.from({ length: 25 }, (_, index) => `problem ${index}`));
	const list = JSON.parse(row().recent_errors);
	assert.equal(list.length, 20);
	assert.deepEqual([list[0].message, list[19].message], ["problem 5", "problem 24"]);
	// Two writers at once both land.
	db.db.exec("UPDATE external_accounts SET recent_errors = '[]'");
	await Promise.all([note(["a"]), note(["b"])]);
	assert.equal(JSON.parse(row().recent_errors).length, 2);
});

test("before migration 0082 an Other address that is taken gets the pending-update answer, never ADDRESS_TAKEN", async (t) => {
	const server = await fake(t);
	const { db, env } = await setup(t, server);
	db.db.exec(
		"DROP INDEX external_accounts_address_idx; CREATE UNIQUE INDEX external_accounts_address_idx ON external_accounts (address);",
	);
	await connectExternalAccount(env, owner, connectBody());
	const refused = await refusal(connectExternalAccount(env, other, connectBody({ mailboxId: "mailbox-b" })));
	assert.deepEqual([refused.status, refused.code], [409, "MIGRATION_PENDING"]);
});
