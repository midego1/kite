import assert from "node:assert/strict";
import { join } from "node:path";
import test, { after } from "node:test";
import { startFakeImap } from "./support/fake-imap.mjs";
import { startFakeSmtp } from "./support/fake-smtp.mjs";
import { bundleModules, root } from "./support/modules-bundle.mjs";
import { createTestCertificate } from "./support/test-certificate.mjs";

// Send-as (spec §7, PR 10) end to end on SQLite through the Node connector: connecting verifies the SMTP sign-in, the
// From menu lists the owner's own connected addresses, `sendEmail` goes through the account's SMTP server with Bcc in
// the envelope only, keeps the exact bytes at `sent/<id>.eml`, and the Sent copy is appended at the fake IMAP server.
// Refusals (another user, switch off, permission revoked, sending off, removed account, size) and the error mapping
// (4xx retried with the same Message-ID, 5xx failed, 535 marks the account, delivery unknown never retried).

const {
	createTcpConnect,
	SqliteDatabase,
	applyMigrations,
	hashPassword,
	connectExternalAccount,
	listExternalAccounts,
	updateExternalAccount,
	retestExternalAccount,
	removeExternalAccount,
	setInstallEnabled,
	setCanConnect,
	listSendIdentities,
	sendEmail,
	processOutboundQueue,
	processAppendSent,
	parseRawMime,
} = await bundleModules("kite-send-as-node-", [
	["createTcpConnect", "server/runtime/tcp-connect.ts"],
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
	["hashPassword", "src/lib/auth/password.ts"],
	[
		"connectExternalAccount, listExternalAccounts, updateExternalAccount, retestExternalAccount, removeExternalAccount",
		"src/lib/external-accounts/service.ts",
	],
	["setInstallEnabled", "src/lib/external-accounts/settings.ts"],
	["setCanConnect", "src/lib/external-accounts/access.ts"],
	["listSendIdentities", "src/lib/external-accounts/identities.ts"],
	["sendEmail, processOutboundQueue", "src/lib/email/send.ts"],
	["processAppendSent", "src/lib/external-accounts/submit.ts"],
	["parseRawMime", "src/lib/email/parse.ts"],
]);

const HOST = "mail.kite.test";
const USER = "user@example.test";
const PASSWORD = "app-password";
const KITE_PASSWORD = "kite-password-1";
const KEY = "test-only-invented-encryption-key-0123456789abcdef";
const tls = createTestCertificate([HOST]);

const previousEnv = globalThis.__kiteNodeEnv;
after(() => {
	globalThis.__kiteNodeEnv = previousEnv;
});

const owner = { id: "owner", role: "user", passwordHash: hashPassword(KITE_PASSWORD) };

async function servers(t, { smtp = {}, imap = {} } = {}) {
	const smtpServer = await startFakeSmtp({ tls, implicitTls: true, users: { [USER]: PASSWORD }, ...smtp });
	const imapServer = await startFakeImap({
		tls,
		implicitTls: true,
		authPlain: true,
		saslIr: true,
		specialUse: true,
		users: { [USER]: PASSWORD },
		folders: { INBOX: [], "Sent Items": [] },
		folderAttributes: { "Sent Items": ["\\Sent"] },
		...imap,
	});
	t.after(() => Promise.all([smtpServer.close(), imapServer.close()]));
	return { smtp: smtpServer, imap: imapServer };
}

/** A bucket in memory, so the stored Sent raw can be read back. */
function memoryBucket() {
	const objects = new Map();
	return {
		objects,
		put: async (key, value) => {
			objects.set(key, new Uint8Array(value instanceof ArrayBuffer ? value : (value.buffer ?? value)).slice());
		},
		get: async (key) => {
			const bytes = objects.get(key);
			return bytes ? { arrayBuffer: async () => bytes.slice().buffer, body: null, size: bytes.byteLength } : null;
		},
		head: async (key) => (objects.has(key) ? { size: objects.get(key).byteLength } : null),
		delete: async (key) => {
			for (const entry of [key].flat()) objects.delete(entry);
		},
		list: async () => ({ objects: [], truncated: false }),
	};
}

async function setup(t, fakes) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, join(root, "drizzle/migrations"));
	const hash = hashPassword(KITE_PASSWORD);
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('owner', 'owner@example.com', '${hash}', 'Owner', 1);
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('other', 'other@example.com', '${hash}', 'Other', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, sending_provider, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 'cloudflare', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'a', 'shared', 1);
		INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES ('access-1', 'mailbox-a', 'other', 'full_access', 1);
	`);
	const connect = createTcpConnect({ ca: tls.cert, resolve: async () => ["127.0.0.1"], allowLoopback: true });
	const ports = { 993: fakes.imap.port, 465: fakes.smtp.port };
	const queued = [];
	const bucket = memoryBucket();
	const env = {
		KITE_RUNTIME: "node",
		APP_ENCRYPTION_KEY: KEY,
		TCP_CONNECT: (address, options) => connect({ ...address, port: ports[address.port] }, options),
		DB: db,
		BUCKET: bucket,
		EMAIL: {
			send: async () => assert.fail("a send as a connected account never uses Kite's own sending"),
		},
		OUTBOUND_QUEUE: { send: async (message, options) => queued.push({ message, options }) },
		AGENT_QUEUE: { send: async () => undefined },
	};
	globalThis.__kiteNodeEnv = env;
	return { db, env, queued, bucket };
}

const connectBody = (overrides = {}) => ({
	address: USER,
	preset: "other",
	mailboxId: "mailbox-a",
	displayName: "Pat Example",
	imap: { host: HOST, port: 993, security: "tls" },
	smtp: { host: HOST, port: 465, security: "tls" },
	password: PASSWORD,
	kitePassword: KITE_PASSWORD,
	...overrides,
});

const send = (env, overrides = {}) =>
	sendEmail(env, {
		userId: "owner",
		mailboxId: "mailbox-a",
		from: USER,
		to: "Friend <friend@example.org>",
		cc: "copy@example.org",
		bcc: "hidden@example.org",
		subject: "Hello from Gmail",
		text: "Hi there.\n.\nA line with a dot.",
		html: "<p>Hi there.</p>",
		connectedAccounts: true,
		...overrides,
	});

async function rejection(promise) {
	try {
		await promise;
	} catch (error) {
		return error.message;
	}
	assert.fail("expected the send to be refused");
}

const messageRow = (db, id) => db.db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
const jobRow = (db, id) => db.db.prepare("SELECT * FROM outbound_jobs WHERE message_id = ?").get(id);
const accountRow = (db) => db.db.prepare("SELECT * FROM external_accounts").get();

test("connecting verifies the SMTP sign-in; the From menu offers the address to its owner only", async (t) => {
	const fakes = await servers(t);
	const { env, db } = await setup(t, fakes);
	const account = await connectExternalAccount(env, owner, connectBody());
	assert.deepEqual(account.sending, { enabled: true, appendSent: true, verified: true, block: null });
	assert.ok(accountRow(db).smtp_verified_at > 0);
	assert.equal(fakes.smtp.auths.length, 1);
	assert.equal(fakes.smtp.messages.length, 0, "the test sends nothing");

	const identities = await listSendIdentities(env, "owner");
	assert.deepEqual(identities.get("mailbox-a"), [
		{
			accountId: account.id,
			address: USER,
			displayName: "Pat Example",
			presetLabel: "Other IMAP provider",
			available: true,
			action: null,
			hint: null,
		},
	]);
	// Sharing the mailbox never shares the account: the other user sees no identity and cannot send as it.
	assert.equal((await listSendIdentities(env, "other")).size, 0);
	assert.match(await rejection(send(env, { userId: "other" })), /Sender address does not match/);
	// Only the signed-in composer may send as a connected account.
	assert.match(await rejection(send(env, { connectedAccounts: false })), /Sender address does not match/);
});

test("a failed SMTP sign-in at connect keeps the account but not the address; Test connection retries it", async (t) => {
	const fakes = await servers(t);
	const { env } = await setup(t, fakes);
	fakes.smtp.failNext("auth", 535, "5.7.8 Username and Password not accepted");
	const account = await connectExternalAccount(env, owner, connectBody());
	assert.equal(account.status, "active");
	assert.equal(account.sending.verified, false);
	assert.equal(account.sending.block, "not_verified");
	assert.match(account.lastError, /^Sending: Sign-in failed/);
	const [identity] = (await listSendIdentities(env, "owner")).get("mailbox-a");
	assert.deepEqual([identity.available, identity.action], [false, "test_connection"]);
	assert.match(await rejection(send(env)), /Test the connection/);

	const outcome = await retestExternalAccount(env, owner, account.id);
	assert.equal(outcome.problem, null);
	assert.equal(outcome.account.sending.block, null);
});

test("a send goes out through the account with Bcc in the envelope only, keeps its bytes and is saved in Sent", async (t) => {
	const fakes = await servers(t);
	const { env, db, queued, bucket } = await setup(t, fakes);
	const account = await connectExternalAccount(env, owner, connectBody());

	const { messageId } = await send(env);
	const [delivered] = fakes.smtp.messages;
	assert.equal(fakes.smtp.messages.length, 1);
	assert.equal(delivered.from, USER);
	assert.deepEqual(delivered.recipients, ["friend@example.org", "copy@example.org", "hidden@example.org"]);
	const raw = delivered.raw.toString("latin1");
	assert.doesNotMatch(raw, /hidden@example\.org/, "Bcc is never a header");
	assert.match(raw, /^From: Pat Example <user@example\.test>\r$/m);
	assert.match(raw, new RegExp(`^Message-ID: <kite\\.${messageId}@example\\.test>\\r$`, "m"));

	const row = messageRow(db, messageId);
	assert.equal(row.status, "sent");
	assert.equal(row.external_account_id, account.id);
	assert.equal(row.raw_r2_key, `sent/${messageId}.eml`);
	assert.equal(row.provider_message_id, `kite.${messageId}@example.test`);
	assert.equal(row.from_addr, '"Pat Example" <user@example.test>');
	assert.equal(jobRow(db, messageId).status, "sent");
	assert.equal(JSON.parse(jobRow(db, messageId).payload).externalAccountId, account.id);
	// The stored bytes are the bytes that went out (the server un-stuffs the dot line again).
	assert.equal(Buffer.from(bucket.objects.get(row.raw_r2_key)).toString("latin1"), raw);
	const parsed = await parseRawMime(bucket.objects.get(row.raw_r2_key).buffer);
	assert.equal(parsed.subject, "Hello from Gmail");

	const appendMessages = queued.filter(({ message }) => message.kind === "accounts.append_sent");
	assert.deepEqual(
		appendMessages.map(({ message }) => message),
		[{ kind: "accounts.append_sent", accountId: account.id, messageId, attempt: 1 }],
	);
	await processAppendSent(env, appendMessages[0].message);
	assert.equal(fakes.imap.appends.length, 1);
	assert.equal(fakes.imap.appends[0].folder, "Sent Items");
	assert.deepEqual(fakes.imap.appends[0].flags, ["\\Seen"]);
	assert.equal(fakes.imap.appends[0].raw, raw);

	// With the switch off, no copy is saved.
	await updateExternalAccount(env, owner, account.id, { appendSent: false });
	const second = await send(env);
	assert.equal(queued.filter(({ message }) => message.messageId === second.messageId).length, 0);
});

test("a failed Sent copy is tried three times and then recorded, never failing the send", async (t) => {
	const fakes = await servers(t, { imap: { appendRefusal: "NO [OVERQUOTA] Mailbox is full" } });
	const { env, db, queued } = await setup(t, fakes);
	await connectExternalAccount(env, owner, connectBody());
	const { messageId } = await send(env);
	let next = queued.find(({ message }) => message.kind === "accounts.append_sent").message;
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		queued.length = 0;
		await processAppendSent(env, next);
		next = queued[0]?.message;
		if (attempt < 3) assert.equal(next.attempt, attempt + 1);
	}
	assert.equal(queued.length, 0);
	assert.equal(messageRow(db, messageId).status, "sent");
	assert.match(accountRow(db).recent_errors, /Saving a copy in Sent failed: IMAP APPEND failed: NO \[OVERQUOTA\]/);
});

test("nothing is sent as an account while connected accounts are off, revoked, sending is off or the account is gone", async (t) => {
	const fakes = await servers(t);
	const { env, db } = await setup(t, fakes);
	const account = await connectExternalAccount(env, owner, connectBody());

	await setInstallEnabled(env, false);
	assert.match(await rejection(send(env)), /You cannot send from this address right now/);
	assert.equal((await listSendIdentities(env, "owner")).size, 0);
	await setInstallEnabled(env, true);

	await setCanConnect(env, "owner", false);
	assert.match(await rejection(send(env)), /You cannot send from this address right now/);
	await setCanConnect(env, "owner", true);

	await updateExternalAccount(env, owner, account.id, { sendEnabled: false });
	assert.match(await rejection(send(env)), /Sending from this account is turned off/);
	await updateExternalAccount(env, owner, account.id, { sendEnabled: true });

	// A scheduled send checks the account again when it runs.
	const scheduled = await send(env, { scheduledAt: new Date(Date.now() + 60_000) });
	assert.equal(scheduled.scheduled, true);
	await removeExternalAccount(env, owner, account.id);
	await processOutboundQueue(env, {
		kind: "email.scheduled",
		jobId: jobRow(db, scheduled.messageId).id,
		messageId: scheduled.messageId,
		scheduledAt: new Date().toISOString(),
	}).catch(() => undefined);
	assert.equal(messageRow(db, scheduled.messageId).status, "failed");
	assert.equal(jobRow(db, scheduled.messageId).error, "The account was removed");
	assert.equal(fakes.smtp.messages.length, 0);
});

test("a 4xx is tried again later with the same Message-ID; a 5xx fails with the server's reply", async (t) => {
	const fakes = await servers(t);
	const { env, db, queued } = await setup(t, fakes);
	await connectExternalAccount(env, owner, connectBody());

	fakes.smtp.failNext("data", 451, "4.3.0 Try again later");
	const first = await send(env);
	assert.equal(first.retrying, true);
	assert.equal(messageRow(db, first.messageId).status, "queued");
	assert.equal(jobRow(db, first.messageId).status, "queued");
	const retry = queued.find(({ message }) => message.kind === "email.scheduled");
	assert.equal(retry.message.attempt, 2);
	assert.equal(retry.options.delaySeconds, 60);
	await processOutboundQueue(env, { ...retry.message, scheduledAt: new Date().toISOString() });
	assert.equal(messageRow(db, first.messageId).status, "sent");
	assert.equal(fakes.smtp.messages.length, 1);
	assert.match(fakes.smtp.messages[0].raw.toString(), new RegExp(`Message-ID: <kite\\.${first.messageId}@`));

	// After the last attempt a 4xx fails the send.
	queued.length = 0;
	fakes.smtp.failNext("data", 451, "4.3.0 Try again later");
	await processOutboundQueue(env, { ...retry.message, attempt: 3 }).catch(() => undefined);

	fakes.smtp.failNext("rcpt", 550, "5.1.1 No such user");
	assert.match(await rejection(send(env)), /refused the recipient friend@example\.org: 550 5\.1\.1 No such user/);
	const failed = db.db.prepare("SELECT * FROM messages WHERE status = 'failed'").all();
	assert.equal(failed.length, 1);
	assert.equal(queued.filter(({ message }) => message.kind === "email.scheduled").length, 0);
});

test("535 at sign-in fails the send and sets the account to Reconnect", async (t) => {
	const fakes = await servers(t);
	const { env, db } = await setup(t, fakes);
	await connectExternalAccount(env, owner, connectBody());
	fakes.smtp.failNext("auth", 535, "5.7.8 Username and Password not accepted");
	assert.match(await rejection(send(env)), /SMTP sign-in failed: 535 5\.7\.8.*Reconnect the account/);
	const row = accountRow(db);
	assert.equal(row.status, "auth_failed");
	assert.equal(row.smtp_verified_at, null);
	assert.ok(!row.last_error.includes(PASSWORD));
	const [identity] = (await listSendIdentities(env, "owner")).get("mailbox-a");
	assert.deepEqual([identity.available, identity.action], [false, "reconnect"]);
	const [account] = await listExternalAccounts(env, "owner");
	assert.equal(account.sending.block, "reconnect");
});

test("a connection lost after the message went out is 'delivery unknown' and never sent again", async (t) => {
	const fakes = await servers(t, { smtp: { afterData: "drop" } });
	const { env, db, queued } = await setup(t, fakes);
	await connectExternalAccount(env, owner, connectBody());
	const message = await rejection(send(env));
	assert.equal(message, "Delivery unknown: check the recipient or the provider's Sent folder before sending again");
	const [row] = db.db.prepare("SELECT * FROM messages WHERE status = 'failed'").all();
	assert.ok(row);
	assert.equal(jobRow(db, row.id).status, "failed");
	assert.equal(jobRow(db, row.id).error, message);
	assert.equal(fakes.smtp.messages.length, 1, "the provider got it once");
	assert.equal(queued.filter(({ message: body }) => body.kind === "email.scheduled").length, 0);
	// The queue redelivering the job finds it failed and sends nothing.
	await processOutboundQueue(env, {
		kind: "email.scheduled",
		jobId: jobRow(db, row.id).id,
		messageId: row.id,
		scheduledAt: new Date().toISOString(),
	});
	assert.equal(fakes.smtp.messages.length, 1);
});

test("a message over the provider's limit is refused before it is queued, naming the limit", async (t) => {
	const fakes = await servers(t);
	const { env, db } = await setup(t, fakes);
	await connectExternalAccount(env, owner, connectBody());
	// iCloud accepts 20 MB as sent; 16 MB of attachment is about 22 MB in base64 lines.
	db.db.exec("UPDATE external_accounts SET preset = 'icloud'");
	const big = new Uint8Array(16_000_000).buffer;
	const message = await rejection(
		send(env, { attachments: [{ filename: "big.bin", type: "application/octet-stream", content: big }] }),
	);
	assert.match(message, /^The message is about 2\d\.\d MB; iCloud Mail accepts at most 20 MB$/);
	assert.equal(db.db.prepare("SELECT count(*) AS n FROM messages").get().n, 0);
});
