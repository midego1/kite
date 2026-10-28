import assert from "node:assert/strict";
import { join } from "node:path";
import test, { after } from "node:test";
import { startFakeImap, sampleMessage } from "./support/fake-imap.mjs";
import { bundleModules, root } from "./support/modules-bundle.mjs";
import { createTestCertificate } from "./support/test-certificate.mjs";

// The IMAP client through the Node server's connector (`server/runtime/tcp-connect.ts`) against the fake IMAP
// server: implicit TLS and STARTTLS with a throwaway certificate, the plain-text refusal, DNS pinning, and a whole
// background import job on SQLite. This is the Node runtime's coverage; e2e runs the workerd dev server.

const {
	createTcpConnect,
	openImapSession,
	openMailSocket,
	MailServerRefusedError,
	SqliteDatabase,
	applyMigrations,
	createImportJob,
	processImportJob,
} = await bundleModules("kite-imap-node-", [
	["createTcpConnect", "server/runtime/tcp-connect.ts"],
	["openImapSession", "src/lib/imap/session.ts"],
	["openMailSocket", "src/lib/net/connect.ts"],
	["MailServerRefusedError", "src/lib/net/errors.ts"],
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
	["createImportJob, processImportJob", "src/lib/import/jobs.ts"],
]);

const HOST = "imap.kite.test";
const USER = "user@example.test";
const PASSWORD = "app-password";
const tls = createTestCertificate([HOST]);

const previousEnv = globalThis.__kiteNodeEnv;
after(() => {
	globalThis.__kiteNodeEnv = previousEnv;
});

/**
 * The connector as the Node server builds it, except that the test resolves `imap.kite.test` to loopback (allowed
 * like the dev flag allows it), trusts the test certificate, and sends the real IMAP ports to the fake's port.
 */
/** `ca: null` trusts only the system store, where the test certificate is not. */
function nodeEnv(fake, { ca = tls.cert, resolve = async () => ["127.0.0.1"], connectTimeoutMs, ...env } = {}) {
	const connect = createTcpConnect({ ca: ca ?? undefined, resolve, allowLoopback: true, connectTimeoutMs });
	return {
		KITE_RUNTIME: "node",
		TCP_CONNECT: (address, options) => connect({ ...address, port: fake.port }, options),
		...env,
	};
}

const login = (overrides = {}) => ({
	host: HOST,
	port: 993,
	security: "tls",
	username: USER,
	password: PASSWORD,
	...overrides,
});

async function fake(t, options) {
	const server = await startFakeImap({ tls, ...options });
	t.after(() => server.close());
	return server;
}

async function readInbox(session) {
	await session.examine("INBOX");
	const uids = await session.searchUids();
	const fetched = await session.fetchMessages(uids);
	return uids.map((uid) => new TextDecoder().decode(fetched.get(uid)));
}

const secretSentInPlainText = (server) =>
	server.commands.some((entry) => !entry.encrypted && /LOGIN|AUTHENTICATE|^[A-Za-z0-9+/=]{16,}$/i.test(entry.line));

test("implicit TLS: verifies the certificate, signs in with AUTHENTICATE PLAIN and SASL-IR, and fetches mail", async (t) => {
	const server = await fake(t, { implicitTls: true, authPlain: true, saslIr: true });
	const session = await openImapSession(nodeEnv(server), login());
	try {
		const [raw] = await readInbox(session);
		assert.match(raw, /Subject: Fake IMAP message 1/);
		assert.deepEqual(await session.listMailboxNames(), ["INBOX"]);
	} finally {
		await session.close();
	}
	const auth = server.commands.find((entry) => / AUTHENTICATE PLAIN /.test(entry.line));
	assert.ok(auth?.encrypted, "the credentials go over TLS");
	assert.ok(!server.commands.some((entry) => / LOGIN /.test(entry.line)), "PLAIN is preferred over LOGIN");
});

test("STARTTLS: upgrades before anything else, asks for capabilities again and only then signs in", async (t) => {
	const server = await fake(t, { starttls: true, loginDisabledWithoutTls: true, authPlain: true });
	const session = await openImapSession(nodeEnv(server), login({ port: 143, security: "starttls" }));
	try {
		assert.equal((await readInbox(session)).length, 1);
	} finally {
		await session.close();
	}
	const names = server.commands.map((entry) => `${entry.encrypted ? "tls" : "plain"} ${entry.line.split(" ")[1]}`);
	assert.deepEqual(names.slice(0, 3), ["plain STARTTLS", "tls CAPABILITY", "tls AUTHENTICATE"]);
	// Without SASL-IR the token follows the server's continuation, still inside TLS.
	assert.ok(server.commands[3].encrypted);
	assert.equal(secretSentInPlainText(server), false);
});

test("LOGIN is the fallback when the server offers no PLAIN mechanism", async (t) => {
	const server = await fake(t, { implicitTls: true, greetingCapabilities: false });
	const session = await openImapSession(nodeEnv(server), login());
	await session.close();
	const lines = server.commands.map((entry) => entry.line.split(" ")[1]);
	assert.deepEqual(lines.slice(0, 2), ["CAPABILITY", "LOGIN"]);
});

test("a server without STARTTLS is refused before any credential is sent", async (t) => {
	const server = await fake(t, { authPlain: true });
	await assert.rejects(
		openImapSession(nodeEnv(server), login({ port: 143, security: "starttls" })),
		(error) => error instanceof MailServerRefusedError && /does not offer STARTTLS/.test(error.message),
	);
	assert.equal(secretSentInPlainText(server), false);
});

test("bytes injected behind the STARTTLS answer end the connection", async (t) => {
	const server = await fake(t, {
		starttls: true,
		authPlain: true,
		injectAfterStartTls: "* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN]\r\n",
	});
	await assert.rejects(
		openImapSession(nodeEnv(server), login({ port: 143, security: "starttls" })),
		(error) => error instanceof MailServerRefusedError && /before the TLS handshake/.test(error.message),
	);
	assert.equal(secretSentInPlainText(server), false);
});

test("certificates are always verified: an untrusted or mismatched certificate fails", async (t) => {
	const server = await fake(t, { implicitTls: true, authPlain: true });
	await assert.rejects(openImapSession(nodeEnv(server, { ca: null }), login()), /Could not connect.*certificate/i);
	const other = createTestCertificate(["other.kite.test"]);
	await assert.rejects(openImapSession(nodeEnv(server, { ca: other.cert }), login()), /Could not connect/);
	const starttls = await fake(t, { starttls: true, authPlain: true });
	await assert.rejects(
		openImapSession(nodeEnv(starttls, { ca: null }), login({ port: 143, security: "starttls" })),
		/TLS handshake .*failed/,
	);
	assert.equal(secretSentInPlainText(starttls), false);
});

test("a wrong password is a sign-in failure, not a refusal", async (t) => {
	const server = await fake(t, { implicitTls: true, authPlain: true, saslIr: true });
	await assert.rejects(
		openImapSession(nodeEnv(server), login({ password: "wrong" })),
		(error) =>
			!(error instanceof MailServerRefusedError) &&
			/IMAP sign-in failed: NO \[AUTHENTICATIONFAILED\]/.test(error.message),
	);
});

test("the connector pins a vetted address and refuses a name with any private address", async (t) => {
	const server = await fake(t, { implicitTls: true, authPlain: true });
	await assert.rejects(
		openImapSession(nodeEnv(server, { resolve: async () => ["93.184.216.34", "10.0.0.7"] }), login()),
		(error) => error instanceof MailServerRefusedError && /Private and local/.test(error.message),
	);
	// Loopback needs the dev flag; private addresses need the self-hosting flag.
	const strict = createTcpConnect({ ca: tls.cert, resolve: async () => ["127.0.0.1"] });
	await assert.rejects(
		strict({ hostname: HOST, port: server.port }, { secureTransport: "on", allowHalfOpen: false }).opened,
		MailServerRefusedError,
	);
	// The private-host setting opens LAN ranges, never loopback, link-local or 0.0.0.0/8.
	for (const address of ["127.0.0.1", "169.254.169.254", "0.0.0.0", "fe80::1"]) {
		const lan = createTcpConnect({ ca: tls.cert, resolve: async () => [address], allowPrivate: true });
		await assert.rejects(
			lan({ hostname: HOST, port: server.port }, { secureTransport: "on", allowHalfOpen: false }).opened,
			MailServerRefusedError,
			address,
		);
	}
	await assert.rejects(
		createTcpConnect({ resolve: async () => [] })(
			{ hostname: HOST, port: 993 },
			{ secureTransport: "on", allowHalfOpen: false },
		).opened,
		/Could not resolve/,
	);
});

test("an address that does not answer falls through to the next vetted one", async (t) => {
	const server = await fake(t, { implicitTls: true, authPlain: true });
	// The fake listens on 127.0.0.1 only, so 127.0.0.2 refuses the connection, as an unreachable IPv6 address would.
	const session = await openImapSession(nodeEnv(server, { resolve: async () => ["127.0.0.2", "127.0.0.1"] }), login());
	assert.equal((await readInbox(session)).length, 1);
	await session.close();
});

test("the guard refuses local hosts and other ports before connecting", async () => {
	let connected = false;
	const env = {
		KITE_RUNTIME: "node",
		TCP_CONNECT: () => {
			connected = true;
			throw new Error("must not connect");
		},
	};
	const target = { host: HOST, port: 25, security: "tls" };
	await assert.rejects(openImapSession(env, login({ port: 25 })), /Port 25 is not allowed.*993 or 143/);
	await assert.rejects(openMailSocket(env, target), /Port 25 is not allowed.*993, 143, 465 or 587/);
	for (const host of ["127.0.0.1", "localhost", "10.1.2.3", "mail.internal", "mailserver"])
		await assert.rejects(openImapSession(env, login({ host })), MailServerRefusedError, host);
	assert.equal(connected, false);
});

test("plain text works only to a loopback fake under the dev flag, outside production", async (t) => {
	const server = await fake(t, { authPlain: true });
	const env = {
		KITE_RUNTIME: "node",
		EXTERNAL_ACCOUNTS_ALLOW_INSECURE_LOOPBACK: "1",
		TCP_CONNECT: createTcpConnect({ allowLoopback: true }),
	};
	const session = await openImapSession(env, login({ host: "127.0.0.1", port: server.port, security: "starttls" }));
	assert.equal((await readInbox(session)).length, 1);
	await session.close();

	const previous = process.env.NODE_ENV;
	process.env.NODE_ENV = "production";
	t.after(() => {
		process.env.NODE_ENV = previous;
	});
	await assert.rejects(
		openImapSession(env, login({ host: "127.0.0.1", port: server.port, security: "starttls" })),
		MailServerRefusedError,
	);
});

test("a background import job runs on the Node runtime over STARTTLS", async (t) => {
	const server = await fake(t, {
		starttls: true,
		authPlain: true,
		folders: { INBOX: [sampleMessage(1), sampleMessage(2), sampleMessage(3)] },
	});
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, join(root, "drizzle/migrations"));
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Owner', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'a', 'personal', 1);
	`);
	const objects = new Map();
	const queued = [];
	const env = {
		...nodeEnv(server),
		DB: db,
		BUCKET: {
			put: async (key, value) => objects.set(key, value),
			get: async () => null,
			head: async () => null,
			delete: async (key) => objects.delete(key),
		},
		AGENT_QUEUE: { send: async (message) => queued.push(message) },
	};
	globalThis.__kiteNodeEnv = env;

	const job = await createImportJob(env, {
		userId: "owner",
		mailboxId: "mailbox-a",
		label: "Old inbox",
		destination: "system:inbox",
		host: HOST,
		port: 143,
		secure: false,
		username: USER,
		password: PASSWORD,
		folder: "INBOX",
		maxMessages: null,
	});
	assert.deepEqual(queued, [{ kind: "import.imap", jobId: job.id }]);
	await processImportJob(env, job.id, { viewer: { userId: "owner" }, moduleId: "import", grants: ["import.run"] });

	const row = db.db.prepare("SELECT status, imported, processed, password, last_error FROM import_jobs").get();
	assert.deepEqual(row, { status: "completed", imported: 3, processed: 3, password: "", last_error: null });
	const subjects = db.db
		.prepare("SELECT subject FROM messages WHERE mailbox_id = 'mailbox-a' ORDER BY subject")
		.all()
		.map((message) => message.subject);
	assert.deepEqual(subjects, ["Fake IMAP message 1", "Fake IMAP message 2", "Fake IMAP message 3"]);
	assert.equal(secretSentInPlainText(server), false);
});

test("a job against a server without TLS fails at once with the reason", async (t) => {
	const server = await fake(t, { authPlain: true });
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, join(root, "drizzle/migrations"));
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Owner', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'a', 'personal', 1);
	`);
	const env = { ...nodeEnv(server), DB: db, AGENT_QUEUE: { send: async () => undefined } };
	globalThis.__kiteNodeEnv = env;
	const job = await createImportJob(env, {
		userId: "owner",
		mailboxId: "mailbox-a",
		label: "Plain",
		destination: "system:inbox",
		host: HOST,
		port: 143,
		secure: false,
		username: USER,
		password: PASSWORD,
		folder: "INBOX",
		maxMessages: null,
	});
	await processImportJob(env, job.id, { viewer: { userId: "owner" }, moduleId: "import", grants: ["import.run"] });
	const row = db.db.prepare("SELECT status, attempts, password, last_error FROM import_jobs").get();
	assert.equal(row.status, "failed");
	assert.equal(row.password, "");
	assert.match(row.last_error, /does not offer STARTTLS/);
	assert.equal(secretSentInPlainText(server), false);
});

test("a literal larger than 64 MB is refused before it is read", async (t) => {
	const server = await fake(t, { implicitTls: true, authPlain: true, saslIr: true, hugeLiteral: true });
	const session = await openImapSession(nodeEnv(server), login());
	try {
		await session.examine("INBOX");
		await assert.rejects(session.fetchMessages(["1"]), (error) => {
			assert.equal(error.message, "The IMAP server sent a message larger than 64 MB");
			return true;
		});
	} finally {
		await session.close();
	}
});

test("a line that never ends is refused at 8 MB", async (t) => {
	const server = await fake(t, { implicitTls: true, endlessLine: true });
	await assert.rejects(openImapSession(nodeEnv(server), login()), (error) => {
		assert.equal(error.message, "The IMAP server sent a line longer than 8 MB");
		return true;
	});
});

test("a server that trickles one byte at a time, or sends nothing, times out per command", async (t) => {
	for (const misbehaviour of [{ slowLoris: true }, { silent: true }]) {
		const server = await fake(t, { implicitTls: true, ...misbehaviour });
		const started = Date.now();
		await assert.rejects(
			openImapSession(nodeEnv(server), login(), { commandTimeoutMs: 400 }),
			/The IMAP server did not answer in time/,
		);
		assert.ok(Date.now() - started < 5_000, "the deadline, not the idle timeout, ends it");
	}
});

test("a server that goes silent after STARTTLS is dropped when the handshake times out", async (t) => {
	const server = await fake(t, { starttls: true, authPlain: true, silentTls: true });
	await assert.rejects(
		openImapSession(nodeEnv(server, { connectTimeoutMs: 300 }), login({ port: 143, security: "starttls" })),
		/TLS handshake .*failed: Timed out during the TLS handshake/,
	);
	// Both the TLS socket and the raw one are destroyed, so the server sees the connection close.
	for (let attempt = 0; attempt < 50 && server.openConnections() > 0; attempt += 1)
		await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(server.openConnections(), 0);
	assert.equal(secretSentInPlainText(server), false);
});

test("a second AUTHENTICATE PLAIN challenge is cancelled, never answered with the password again", async (t) => {
	const server = await fake(t, { implicitTls: true, authPlain: true, secondChallenge: true });
	await assert.rejects(
		openImapSession(nodeEnv(server), login()),
		/IMAP sign-in failed: the server asked for more than one response/,
	);
	const token = Buffer.from(`\0${USER}\0${PASSWORD}`).toString("base64");
	assert.equal(server.commands.filter((entry) => entry.line === token).length, 1);
	assert.ok(server.commands.some((entry) => entry.line === "*"));
});

test("LOGIN sends a non-ASCII password as a literal, and NUL is refused for every mechanism", async (t) => {
	const password = 'pässwörd "quoted" ✓';
	const server = await fake(t, { implicitTls: true, users: { [USER]: password } });
	const session = await openImapSession(nodeEnv(server), login({ password }));
	await session.close();
	assert.ok(server.commands.some((entry) => / LOGIN /.test(entry.line) && entry.line.includes("pässwörd")));
	await assert.rejects(openImapSession(nodeEnv(server), login({ password: "a\0b" })), /cannot contain a NUL/);
	const plain = await fake(t, { implicitTls: true, authPlain: true, saslIr: true });
	await assert.rejects(openImapSession(nodeEnv(plain), login({ username: "a\0b" })), /cannot contain a NUL/);
	assert.equal(plain.commands.filter((entry) => / AUTHENTICATE /.test(entry.line)).length, 0);
});
