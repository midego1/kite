import assert from "node:assert/strict";
import { join } from "node:path";
import test, { after } from "node:test";
import { startFakeImap, sampleMessage } from "./support/fake-imap.mjs";
import { bundleModules, root } from "./support/modules-bundle.mjs";
import { createTestCertificate } from "./support/test-certificate.mjs";

// Connected accounts (spec §6, §9, §10.2, §11; PR 6): provider presets and MX detection, the server guard, the
// connect flow with its checks, the INBOX baseline, sealed passwords that no answer or backup carries, the install
// switch and the per-user permission, `moduleHost.accounts.sourceLogin`, and an import from a connected account,
// all through the Node connector against the fake IMAP server on SQLite.

const {
	createTcpConnect,
	SqliteDatabase,
	applyMigrations,
	hashPassword,
	detectPreset,
	presetForDomain,
	presetForMx,
	mxHost,
	parseAccountInput,
	AccountInputError,
	classifyConnectionError,
	serializeExternalAccount,
	appendRecentError,
	assertMailServerHost,
	connectExternalAccount,
	listExternalAccounts,
	updateExternalAccount,
	retestExternalAccount,
	removeExternalAccount,
	setInstallEnabled,
	readInstallState,
	setCanConnect,
	connectRefusal,
	externalSourceLogin,
	eraseIdleExternalCredentials,
	redactBackupRow,
	restoredBackupRow,
	createImportJob,
	processImportJob,
	listImportJobs,
	serializeImportJob,
} = await bundleModules("kite-external-accounts-node-", [
	["createTcpConnect", "server/runtime/tcp-connect.ts"],
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
	["hashPassword", "src/lib/auth/password.ts"],
	["detectPreset", "src/lib/external-accounts/detect.ts"],
	["presetForDomain, presetForMx, mxHost", "src/lib/external-accounts/presets-utils.ts"],
	["parseAccountInput, AccountInputError", "src/lib/external-accounts/input-utils.ts"],
	["classifyConnectionError", "src/lib/external-accounts/connection-utils.ts"],
	["serializeExternalAccount, appendRecentError", "src/lib/external-accounts/serialize-utils.ts"],
	["assertMailServerHost", "src/lib/external-accounts/host-guard.ts"],
	[
		"connectExternalAccount, listExternalAccounts, updateExternalAccount, retestExternalAccount, removeExternalAccount",
		"src/lib/external-accounts/service.ts",
	],
	["setInstallEnabled, readInstallState", "src/lib/external-accounts/settings.ts"],
	["setCanConnect, connectRefusal", "src/lib/external-accounts/access.ts"],
	["externalSourceLogin", "src/lib/external-accounts/source-login.ts"],
	["eraseIdleExternalCredentials", "src/lib/external-accounts/retention.ts"],
	["redactBackupRow, restoredBackupRow", "src/lib/backups/external-accounts-utils.ts"],
	["createImportJob, processImportJob, listImportJobs, serializeImportJob", "src/lib/import/jobs.ts"],
]);

const HOST = "imap.kite.test";
const USER = "user@example.test";
const PASSWORD = "app-password";
const KITE_PASSWORD = "kite-password-1";
const KEY = "test-only-invented-encryption-key-0123456789abcdef";
const tls = createTestCertificate([HOST]);
const CTX = { viewer: null, requestId: "r", locale: "en", timeZone: "UTC", grants: ["import.run"], trigger: "queue" };

const previousEnv = globalThis.__kiteNodeEnv;
after(() => {
	globalThis.__kiteNodeEnv = previousEnv;
});

async function fake(t, options = {}) {
	const server = await startFakeImap({ tls, implicitTls: true, authPlain: true, saslIr: true, ...options });
	t.after(() => server.close());
	return server;
}

async function setup(t, server, extra = {}) {
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, join(root, "drizzle/migrations"));
	const hash = hashPassword(KITE_PASSWORD);
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('owner', 'owner@example.com', '${hash}', 'Owner', 1);
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('other', 'other@example.com', '${hash}', 'Other', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'a', 'personal', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mailbox-b', 'other', 'domain-1', 'b', 'personal', 1);
	`);
	const connect = createTcpConnect({ ca: tls.cert, resolve: async () => ["127.0.0.1"], allowLoopback: true });
	const queued = [];
	const env = {
		KITE_RUNTIME: "node",
		APP_ENCRYPTION_KEY: KEY,
		TCP_CONNECT: (address, options) => connect({ ...address, port: server.port }, options),
		DB: db,
		BUCKET: {
			put: async () => undefined,
			get: async () => null,
			head: async () => null,
			delete: async () => undefined,
		},
		AGENT_QUEUE: { send: async (message) => queued.push(message) },
		...extra,
	};
	globalThis.__kiteNodeEnv = env;
	return { db, env, queued };
}

const owner = { id: "owner", role: "user", passwordHash: hashPassword(KITE_PASSWORD) };
const other = { id: "other", role: "user", passwordHash: hashPassword(KITE_PASSWORD) };
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

test("presets are found by address domain and, for custom domains, by MX records", async () => {
	assert.equal(presetForDomain("gmail.com").id, "gmail");
	assert.equal(presetForDomain("me.com").id, "icloud");
	assert.equal(presetForDomain("yahoo.co.uk").id, "yahoo");
	assert.equal(presetForDomain("hotmail.de").id, "microsoft");
	assert.equal(presetForDomain("example.org"), null);
	assert.equal(mxHost("10 ASPMX.L.GOOGLE.COM."), "aspmx.l.google.com");
	assert.equal(presetForMx(["alt1.aspmx.l.google.com"]).id, "google_workspace");
	assert.equal(presetForMx(["smtp.google.com"]).id, "google_workspace");
	assert.equal(presetForMx(["acme-com.mail.protection.outlook.com"]).id, "microsoft");
	assert.equal(presetForMx(["in1-smtp.messagingengine.com"]).id, "fastmail");
	assert.equal(presetForMx(["mx.evil-google.com"]), null);

	const asked = [];
	const lookup = (answers) => async (domain) => {
		asked.push(domain);
		if (answers instanceof Error) throw answers;
		return answers;
	};
	assert.equal((await detectPreset("me@gmail.com", lookup([]))).id, "gmail");
	assert.equal((await detectPreset("me@acme.org", lookup(["1 smtp.google.com."]))).id, "google_workspace");
	assert.equal(
		(await detectPreset("me@acme.org", lookup(["0 acme-org.mail.protection.outlook.com."]))).id,
		"microsoft",
	);
	assert.equal((await detectPreset("me@acme.org", lookup(new Error("DNS down")))).id, "other");
	asked.length = 0;
	assert.equal((await detectPreset("me@example.test", lookup(["1 smtp.google.com."]))).id, "other");
	assert.equal((await detectPreset("not an address", lookup([]))).id, "other");
	assert.deepEqual(asked, [], "reserved test domains and non-addresses are never looked up");
});

test("a known preset brings its own servers; Other needs an IMAP server", () => {
	const gmail = parseAccountInput({
		address: " Me@Gmail.com ",
		preset: "gmail",
		mailboxId: "m",
		imap: { host: "evil.example", port: 993, security: "tls" },
	});
	assert.equal(gmail.address, "me@gmail.com");
	assert.equal(gmail.username, "me@gmail.com");
	assert.deepEqual(gmail.imap, { host: "imap.gmail.com", port: 993, security: "tls" });
	assert.deepEqual(gmail.smtp, { host: "smtp.gmail.com", port: 465, security: "tls" });
	assert.throws(() => parseAccountInput({ address: "me@x.org", preset: "other", mailboxId: "m" }), AccountInputError);
	assert.throws(
		() =>
			parseAccountInput({
				address: "me@x.org",
				preset: "other",
				mailboxId: "m",
				imap: { host: "h.x.org", port: 993, security: "none" },
			}),
		/TLS or STARTTLS/,
	);
	assert.throws(() => parseAccountInput({ address: "me@x.org", preset: "pop3", mailboxId: "m" }), /provider/);
});

test("connection errors never repeat the password and say what kind of problem it was", () => {
	const auth = classifyConnectionError(new Error(`IMAP sign-in failed: NO [AUTHENTICATIONFAILED] bad ${PASSWORD}`), {
		refused: false,
		secrets: [PASSWORD],
	});
	assert.equal(auth.kind, "auth");
	assert.ok(!auth.message.includes(PASSWORD));
	assert.equal(
		classifyConnectionError(new Error("The TLS handshake failed: self-signed certificate"), { refused: false }).kind,
		"tls",
	);
	assert.equal(classifyConnectionError(new Error("Private hosts are refused"), { refused: true }).kind, "refused");
	assert.equal(classifyConnectionError(new Error("x".repeat(500)), { refused: false }).message.length, 300);
});

test("the server guard refuses other ports, private literals and names that resolve to private addresses", async () => {
	await assert.rejects(assertMailServerHost({}, "imap.example.org", 22), /Port 22 is not allowed/);
	await assert.rejects(assertMailServerHost({}, "10.0.0.5", 993), /Private and local/);
	await assert.rejects(assertMailServerHost({}, "localhost", 993), /Private and local/);
	const resolving = (addresses) => ({ KITE_RUNTIME: "node", RESOLVE_HOST: async () => addresses });
	await assert.rejects(
		assertMailServerHost(resolving(["93.184.216.34", "192.168.1.9"]), "imap.example.org", 993),
		/Private and local/,
	);
	await assertMailServerHost(resolving(["93.184.216.34"]), "imap.example.org", 993);
	await assertMailServerHost(
		{ ...resolving(["192.168.1.9"]), EXTERNAL_ACCOUNTS_ALLOW_PRIVATE_HOSTS: "1" },
		"imap.lan.example",
		993,
	);
});

test("connecting tests the sign-in, seals the password, stores the INBOX baseline and never returns the secret", async (t) => {
	const server = await fake(t, {
		folders: { INBOX: [sampleMessage(1), sampleMessage(2), sampleMessage(3)] },
	});
	const { db, env } = await setup(t, server);

	const account = await connectExternalAccount(env, owner, connectBody({ label: "Old mail" }));
	assert.equal(account.address, USER);
	assert.equal(account.status, "active");
	assert.equal(account.hasPassword, true);
	assert.ok(!JSON.stringify(account).includes(PASSWORD));
	assert.ok(!("secret" in account));

	const row = db.db.prepare("SELECT * FROM external_accounts WHERE id = ?").get(account.id);
	assert.ok(row.secret.startsWith("enc:v1:"), "the password is sealed");
	assert.ok(!row.secret.includes(PASSWORD));
	const folder = db.db.prepare("SELECT * FROM external_account_folders WHERE account_id = ?").get(account.id);
	assert.deepEqual(
		[folder.name, folder.role, folder.uidvalidity, folder.uidnext, folder.last_uid],
		["INBOX", "inbox", 1, 4, 3],
	);
	const audit = db.db.prepare("SELECT action, metadata FROM audit_logs ORDER BY created_at").all();
	assert.deepEqual(
		audit.map((entry) => entry.action),
		["external_account.connection_tested", "external_account.connected"],
	);
	assert.ok(audit.every((entry) => !entry.metadata.includes(PASSWORD)));
	assert.deepEqual(
		(await listExternalAccounts(env, "owner")).map((entry) => entry.id),
		[account.id],
	);
	assert.deepEqual(await listExternalAccounts(env, "other"), []);

	// The same address cannot be connected twice, by anyone.
	assert.equal((await refusal(connectExternalAccount(env, owner, connectBody()))).code, "ADDRESS_TAKEN");
});

test("connecting is refused without the Kite password, for a Kite domain, a foreign mailbox or a wrong password", async (t) => {
	const server = await fake(t);
	const { db, env } = await setup(t, server);

	assert.equal(
		(await refusal(connectExternalAccount(env, owner, connectBody({ kitePassword: "nope" })))).code,
		"KITE_PASSWORD",
	);
	assert.equal(
		(await refusal(connectExternalAccount(env, owner, connectBody({ address: "me@example.com" })))).code,
		"KITE_DOMAIN",
	);
	assert.equal(
		(await refusal(connectExternalAccount(env, owner, connectBody({ mailboxId: "mailbox-b" })))).status,
		404,
	);
	assert.equal(
		(await refusal(connectExternalAccount(env, owner, connectBody({ preset: "microsoft" })))).code,
		"OAUTH_REQUIRED",
	);
	assert.equal(
		(
			await refusal(
				connectExternalAccount(env, owner, connectBody({ imap: { host: "10.0.0.1", port: 993, security: "tls" } })),
			)
		).code,
		"SERVER_REFUSED",
	);
	const wrong = await refusal(connectExternalAccount(env, owner, connectBody({ password: "wrong-password" })));
	assert.equal(wrong.code, "CONNECTION_AUTH");
	assert.ok(!wrong.message.includes("wrong-password"));
	assert.equal(db.db.prepare("SELECT count(*) AS n FROM external_accounts").get().n, 0);
});

test("connection tests are limited to ten per user in ten minutes", async (t) => {
	const server = await fake(t);
	const { env } = await setup(t, server);
	for (let attempt = 0; attempt < 10; attempt += 1)
		assert.equal(
			(await refusal(connectExternalAccount(env, owner, connectBody({ password: "wrong" })))).code,
			"CONNECTION_AUTH",
		);
	assert.equal((await refusal(connectExternalAccount(env, owner, connectBody()))).status, 429);
	// Another user has their own budget.
	await connectExternalAccount(env, other, connectBody({ mailboxId: "mailbox-b" }));
});

test("without APP_ENCRYPTION_KEY, with the switch off or without the permission nothing can be connected", async (t) => {
	const server = await fake(t);
	const noKey = await setup(t, server, { APP_ENCRYPTION_KEY: "" });
	assert.equal(await connectRefusal(noKey.env, "owner"), "no_key");
	assert.equal((await refusal(connectExternalAccount(noKey.env, owner, connectBody()))).code, "NO_KEY");
	assert.equal((await readInstallState(noKey.env)).enabled, false);
	assert.equal((await refusal(setInstallEnabled(noKey.env, true))).status, 409);

	const { env } = await setup(t, server);
	assert.equal((await readInstallState(env)).enabled, true, "on by default with a key");
	await setInstallEnabled(env, false);
	assert.equal((await refusal(connectExternalAccount(env, owner, connectBody()))).code, "INSTALL_OFF");
	await setInstallEnabled(env, true);
	await setCanConnect(env, "owner", false);
	assert.equal((await refusal(connectExternalAccount(env, owner, connectBody()))).status, 403);
});

test("sourceLogin hands the login to the owner's job only, and stops when the account cannot be used", async (t) => {
	const server = await fake(t);
	const { db, env } = await setup(t, server);
	const account = await connectExternalAccount(env, owner, connectBody());
	const request = { accountId: account.id, userId: "owner" };

	const answer = await externalSourceLogin(env, CTX, request);
	assert.deepEqual(answer, {
		ok: true,
		login: { host: HOST, port: 993, security: "tls", username: USER, auth: { kind: "password", password: PASSWORD } },
	});
	assert.equal((await externalSourceLogin(env, CTX, { ...request, userId: "other" })).reason, "removed");
	const otherViewer = { ...CTX, viewer: { userId: "other", role: "user", isPrimaryAdmin: false } };
	assert.equal((await externalSourceLogin(env, otherViewer, request)).reason, "removed");

	await setCanConnect(env, "owner", false);
	assert.equal((await externalSourceLogin(env, CTX, request)).reason, "not_allowed");
	assert.equal(
		db.db.prepare("SELECT status, status_reason FROM external_accounts").get().status_reason,
		"permission_revoked",
	);
	await setCanConnect(env, "owner", true);
	assert.equal(db.db.prepare("SELECT status FROM external_accounts").get().status, "active");

	// A key that no longer opens the password marks the account for reconnecting.
	globalThis.__kiteNodeEnv = { ...env, APP_ENCRYPTION_KEY: "another-invented-key-0123456789abcdefghijkl" };
	assert.equal(
		(
			await externalSourceLogin(
				{ ...env, APP_ENCRYPTION_KEY: "another-invented-key-0123456789abcdefghijkl" },
				CTX,
				request,
			)
		).reason,
		"auth_failed",
	);
	globalThis.__kiteNodeEnv = env;
	assert.equal(db.db.prepare("SELECT status FROM external_accounts").get().status, "auth_failed");

	await removeExternalAccount(env, owner, account.id);
	assert.equal((await externalSourceLogin(env, CTX, request)).reason, "removed");
});

test("Test connection records a failed sign-in, and reconnecting with a new password makes the account active", async (t) => {
	const server = await fake(t);
	const { env } = await setup(t, server);
	const account = await connectExternalAccount(env, owner, connectBody());

	server.failNextLogin();
	const failed = await retestExternalAccount(env, owner, account.id);
	assert.equal(failed.problem.kind, "auth");
	assert.equal(failed.account.status, "auth_failed");

	// A label change needs no password; a new password needs the Kite password and a passing test.
	const renamed = await updateExternalAccount(env, owner, account.id, { label: "Archive" });
	assert.equal(renamed.label, "Archive");
	assert.equal(renamed.status, "auth_failed");
	assert.equal(
		(await refusal(updateExternalAccount(env, owner, account.id, { password: PASSWORD }))).code,
		"KITE_PASSWORD",
	);
	const reconnected = await updateExternalAccount(env, owner, account.id, {
		password: PASSWORD,
		kitePassword: KITE_PASSWORD,
	});
	assert.equal(reconnected.status, "active");
	assert.equal(reconnected.lastError, null);
	assert.equal((await refusal(updateExternalAccount(env, other, account.id, { label: "x" }))).status, 404);
});

test("an import from a connected account keeps no password and stops once the account is removed", async (t) => {
	const server = await fake(t, {
		folders: { INBOX: [sampleMessage(1, { subject: "From the account" }), sampleMessage(2, { subject: "Second" })] },
	});
	const { db, env } = await setup(t, server);
	const account = await connectExternalAccount(env, owner, connectBody());
	const job = await createImportJob(env, {
		userId: "owner",
		mailboxId: "mailbox-a",
		label: "INBOX",
		destination: "system:inbox",
		host: HOST,
		port: 993,
		secure: true,
		username: USER,
		password: "",
		externalAccountId: account.id,
		folder: "INBOX",
		maxMessages: null,
	});
	const stored = db.db
		.prepare("SELECT password, external_account_id, options FROM import_jobs WHERE id = ?")
		.get(job.id);
	assert.deepEqual([stored.password, stored.external_account_id], ["", account.id]);
	assert.equal(JSON.parse(stored.options).connectedAccount, true);

	await processImportJob(env, job.id, CTX);
	const subjects = db.db
		.prepare("SELECT subject FROM messages ORDER BY subject")
		.all()
		.map((row) => row.subject);
	assert.deepEqual(subjects, ["From the account", "Second"]);
	const [listed] = await listImportJobs(env, "owner");
	assert.equal(serializeImportJob(listed).externalAccountId, account.id);
	assert.ok(!JSON.stringify(serializeImportJob(listed)).includes(PASSWORD));

	// A second job from the same account, started before the account is removed, fails at its next run.
	const second = await createImportJob(env, {
		userId: "owner",
		mailboxId: "mailbox-a",
		label: "INBOX again",
		destination: "system:inbox",
		host: HOST,
		port: 993,
		secure: true,
		username: USER,
		password: "",
		externalAccountId: account.id,
		folder: "INBOX",
		maxMessages: null,
	});
	await removeExternalAccount(env, owner, account.id);
	await processImportJob(env, second.id, CTX);
	const ended = db.db
		.prepare("SELECT status, last_error, external_account_id FROM import_jobs WHERE id = ?")
		.get(second.id);
	assert.deepEqual(
		[ended.status, ended.last_error, ended.external_account_id],
		["failed", "The account was removed", null],
	);
	// Removing the account keeps its mail.
	assert.equal(db.db.prepare("SELECT count(*) AS n FROM messages").get().n, 2);
});

test("passwords are erased 30 days after the switch went off or the permission was taken away", async (t) => {
	const server = await fake(t);
	const { db, env } = await setup(t, server);
	const mine = await connectExternalAccount(env, owner, connectBody());
	const theirs = await connectExternalAccount(
		env,
		other,
		connectBody({ address: "them@example.test", username: USER, mailboxId: "mailbox-b" }),
	);
	await setCanConnect(env, "other", false);
	const now = new Date();
	assert.equal(await eraseIdleExternalCredentials(env, now), 0);
	const later = new Date(now.getTime() + 31 * 24 * 60 * 60_000);
	assert.equal(await eraseIdleExternalCredentials(env, later), 1);
	const row = (id) => db.db.prepare("SELECT secret, status FROM external_accounts WHERE id = ?").get(id);
	assert.deepEqual(row(theirs.id), { secret: "", status: "disabled" });
	assert.equal(row(mine.id).status, "active");

	await setInstallEnabled(env, false);
	assert.equal(await eraseIdleExternalCredentials(env, new Date()), 0);
	assert.equal(await eraseIdleExternalCredentials(env, later), 1);
	assert.deepEqual(row(mine.id), { secret: "", status: "disabled" });
});

test("backups leave the password out and restore accounts waiting to be reconnected", () => {
	const row = { id: "x", address: USER, secret: "enc:v1:abc:def", status: "active", status_reason: null };
	assert.equal(redactBackupRow("external_accounts", row).secret, "");
	assert.equal(row.secret, "enc:v1:abc:def", "the live row is not changed");
	assert.deepEqual(redactBackupRow("messages", row), row);
	const restored = restoredBackupRow("external_accounts", row);
	assert.deepEqual([restored.secret, restored.status, restored.status_reason], ["", "auth_failed", "restored"]);
	assert.equal(
		serializeExternalAccount({
			id: "x",
			label: "x",
			address: USER,
			displayName: null,
			preset: "other",
			mailboxId: "m",
			imapHost: HOST,
			imapPort: 993,
			imapSecurity: "tls",
			smtpHost: null,
			smtpPort: null,
			smtpSecurity: null,
			username: USER,
			secret: "",
			status: "auth_failed",
			statusReason: "restored",
			lastError: null,
			createdAt: new Date(0),
			updatedAt: new Date(0),
		}).hasPassword,
		false,
	);
});

test("an account's recent problems keep the last 20 and survive a damaged list", () => {
	const at = new Date("2026-10-29T10:00:00Z");
	assert.deepEqual(JSON.parse(appendRecentError("not json", "first", at)), [
		{ at: at.toISOString(), message: "first" },
	]);
	assert.deepEqual(JSON.parse(appendRecentError('{"a":1}', "first", at)).length, 1);
	const mixed = JSON.stringify([{ at: "x", message: "kept" }, { at: 1, message: "dropped" }, null, "dropped"]);
	assert.deepEqual(
		JSON.parse(appendRecentError(mixed, "new", at)).map((entry) => entry.message),
		["kept", "new"],
	);
	let list = "[]";
	for (let index = 0; index < 25; index += 1) list = appendRecentError(list, `problem ${index}`, at);
	const parsed = JSON.parse(list);
	assert.equal(parsed.length, 20);
	assert.equal(parsed[0].message, "problem 5");
	assert.equal(parsed[19].message, "problem 24");
});

test("the public shape names the SMTP server only when all of it is known, and never the password", () => {
	const base = {
		id: "x",
		label: "x",
		address: USER,
		displayName: "Me",
		preset: "gmail",
		mailboxId: "m",
		imapHost: "imap.gmail.com",
		imapPort: 993,
		imapSecurity: "tls",
		smtpHost: "smtp.gmail.com",
		smtpPort: 465,
		smtpSecurity: "tls",
		username: USER,
		secret: "enc:v1:abc:def",
		status: "active",
		statusReason: null,
		lastError: null,
		createdAt: new Date(0),
		updatedAt: new Date(0),
	};
	const view = serializeExternalAccount(base);
	assert.deepEqual(view.smtp, { host: "smtp.gmail.com", port: 465, security: "tls" });
	assert.equal(view.presetLabel, "Gmail");
	assert.equal(view.hasPassword, true);
	assert.ok(!JSON.stringify(view).includes("enc:v1"));
	assert.equal(serializeExternalAccount({ ...base, smtpPort: null }).smtp, null);
	assert.equal(serializeExternalAccount({ ...base, preset: "retired" }).presetLabel, "IMAP");
});
