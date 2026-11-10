import assert from "node:assert/strict";
import { join } from "node:path";
import test, { after } from "node:test";
import { sampleMessage, startFakeImap } from "./support/fake-imap.mjs";
import { startFakeMicrosoftOAuth } from "./support/fake-microsoft-oauth.mjs";
import { startFakeSmtp } from "./support/fake-smtp.mjs";
import { bundleModules, root } from "./support/modules-bundle.mjs";
import { createTestCertificate } from "./support/test-certificate.mjs";

// Sign in with Microsoft (spec §15) through the Node connector against fakes of Microsoft's token endpoint, Outlook's
// IMAP and SMTP servers, on SQLite: the owner's registration (checked, sealed, never answered), the flow with PKCE and
// a single-use state, connecting and reconnecting, XOAUTH2 for sync, sending and imports, refresh with rotation and
// compare-and-swap, a refused cached token, a revoked sign-in, and the tokens kept out of backups.

const {
	createTcpConnect,
	SqliteDatabase,
	applyMigrations,
	hashPassword,
	setInstallEnabled,
	saveMicrosoftClient,
	validateMicrosoftClient,
	microsoftClientStatus,
	resolveMicrosoftClient,
	startMicrosoftSignIn,
	completeMicrosoftSignIn,
	oauthAccessToken,
	CredentialUnavailableError,
	storeRefreshedTokens,
	readTokenState,
	listExternalAccounts,
	retestExternalAccount,
	openSession,
	SyncRefusedError,
	externalSourceLogin,
	eraseIdleExternalCredentials,
	redactBackupRow,
	openSmtpSession,
	SmtpReplyError,
} = await bundleModules("kite-external-oauth-node-", [
	["createTcpConnect", "server/runtime/tcp-connect.ts"],
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
	["hashPassword", "src/lib/auth/password.ts"],
	["setInstallEnabled", "src/lib/external-accounts/settings.ts"],
	[
		"saveMicrosoftClient, validateMicrosoftClient, microsoftClientStatus, resolveMicrosoftClient",
		"src/lib/external-accounts/oauth-client.ts",
	],
	["startMicrosoftSignIn, completeMicrosoftSignIn", "src/lib/external-accounts/oauth-flow.ts"],
	["oauthAccessToken, CredentialUnavailableError", "src/lib/external-accounts/oauth-tokens.ts"],
	["storeRefreshedTokens, readTokenState", "src/lib/external-accounts/oauth-store.ts"],
	["listExternalAccounts, retestExternalAccount", "src/lib/external-accounts/service.ts"],
	["openSession, SyncRefusedError", "src/lib/external-accounts/sync-run.ts"],
	["externalSourceLogin", "src/lib/external-accounts/source-login.ts"],
	["eraseIdleExternalCredentials", "src/lib/external-accounts/retention.ts"],
	["redactBackupRow", "src/lib/backups/external-accounts-utils.ts"],
	["openSmtpSession", "src/lib/smtp/session.ts"],
	["SmtpReplyError", "src/lib/smtp/errors.ts"],
]);

const ADDRESS = "someone@outlook.test";
const KITE_PASSWORD = "kite-password-1";
const KEY = "test-only-invented-encryption-key-0123456789abcdef";
const ORIGIN = "http://kite.test";
const tls = createTestCertificate(["outlook.office365.com", "smtp.office365.com"]);
const CTX = { viewer: null, requestId: "r", locale: "en", timeZone: "UTC", grants: ["import.run"], trigger: "queue" };

const previousEnv = globalThis.__kiteNodeEnv;
after(() => {
	globalThis.__kiteNodeEnv = previousEnv;
});

const owner = { id: "owner", role: "user", passwordHash: hashPassword(KITE_PASSWORD) };
const other = { id: "other", role: "user", passwordHash: hashPassword(KITE_PASSWORD) };

/** Microsoft's token endpoint, Outlook's IMAP (993) and SMTP (587) fakes, and a migrated database with two users. */
async function setup(t, { saveClient = true } = {}) {
	const accessTokens = {};
	const oauth = await startFakeMicrosoftOAuth({
		account: { address: ADDRESS, oid: "oid-1" },
		onAccessToken: (address, token) => {
			accessTokens[address] = token;
		},
	});
	const imap = await startFakeImap({
		tls,
		implicitTls: true,
		saslIr: true,
		accessTokens,
		folders: { INBOX: [sampleMessage(1, { subject: "Before connecting" })], Sent: [] },
	});
	t.after(() => Promise.all([oauth.close(), imap.close()]));
	const smtp = await startFakeSmtp({ tls, authMethods: ["XOAUTH2"], accessTokens });
	t.after(() => smtp.close());
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, join(root, "drizzle/migrations"));
	const hash = hashPassword(KITE_PASSWORD);
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('owner', 'owner@example.com', '${hash}', 'Owner', 1);
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('other', 'other@example.com', '${hash}', 'Other', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'a', 'personal', 1);
	`);
	const connect = createTcpConnect({ ca: tls.cert, resolve: async () => ["127.0.0.1"], allowLoopback: true });
	const ports = { 993: imap.port, 587: smtp.port };
	const env = {
		KITE_RUNTIME: "node",
		APP_ENCRYPTION_KEY: KEY,
		EXTERNAL_OAUTH_TEST_ORIGIN: oauth.origin,
		TCP_CONNECT: (address, options) => connect({ ...address, port: ports[address.port] ?? address.port }, options),
		DB: db,
		BUCKET: {
			put: async () => undefined,
			get: async () => null,
			head: async () => null,
			delete: async () => undefined,
		},
		AGENT_QUEUE: { send: async () => undefined },
	};
	globalThis.__kiteNodeEnv = env;
	await setInstallEnabled(env, true);
	if (saveClient)
		await saveMicrosoftClient(env, { clientId: oauth.clientId, clientSecret: oauth.clientSecret, tenant: "common" });
	return { db, env, oauth, imap, smtp, accessTokens };
}

/** Starts a sign-in, lets the fake consent, and answers the callback's query, as the browser would carry it. */
async function signIn(env, actor = owner, body = {}) {
	const { url } = await startMicrosoftSignIn(
		env,
		actor,
		{ mailboxId: "mailbox-a", kitePassword: KITE_PASSWORD, address: ADDRESS, ...body },
		ORIGIN,
	);
	const response = await fetch(url, { redirect: "manual" });
	assert.equal(response.status, 302);
	const callback = new URL(response.headers.get("location"));
	assert.equal(callback.origin + callback.pathname, `${ORIGIN}/api/external-accounts/oauth/callback`);
	return { url: new URL(url), params: callback.searchParams };
}

const accountRow = (db) => db.db.prepare("SELECT * FROM external_accounts").get();

async function refusal(promise) {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	assert.fail("expected a refusal");
}

test("the owner's registration is checked with Microsoft, stored sealed, and never answered", async (t) => {
	const { db, env, oauth } = await setup(t, { saveClient: false });
	const redirect = `${ORIGIN}/api/external-accounts/oauth/callback`;
	const wrong = await validateMicrosoftClient(
		env,
		{ clientId: oauth.clientId, clientSecret: "wrong", tenant: "common" },
		redirect,
	);
	assert.equal(wrong.verdict, "rejected");
	assert.match(wrong.error, /AADSTS7000215/);
	const unknown = await validateMicrosoftClient(
		env,
		{ clientId: "99999999-2222-3333-4444-555555555555", clientSecret: oauth.clientSecret, tenant: "common" },
		redirect,
	);
	assert.match(unknown.error, /AADSTS700016/);
	const client = { clientId: oauth.clientId, clientSecret: oauth.clientSecret, tenant: "common" };
	assert.deepEqual(await validateMicrosoftClient(env, client, redirect), { verdict: "ok" });

	const withoutKey = await refusal(saveMicrosoftClient({ ...env, APP_ENCRYPTION_KEY: "" }, client));
	assert.equal(withoutKey.code, "NO_KEY");
	await saveMicrosoftClient(env, client);
	const stored = db.db
		.prepare("SELECT oauth_microsoft_client AS value FROM app_settings WHERE id = 'default'")
		.get().value;
	assert.match(stored, /^enc:v1:/);
	assert.ok(!stored.includes(oauth.clientSecret));
	assert.deepEqual(await resolveMicrosoftClient(env), client);
	const status = await microsoftClientStatus(env, ORIGIN);
	assert.equal(status.source, "settings");
	assert.equal(status.redirectUri, redirect);
	assert.ok(!JSON.stringify(status).includes(oauth.clientSecret));
	// The variables win over the saved registration.
	const fromEnv = {
		...env,
		MICROSOFT_OAUTH_CLIENT_ID: "AAAAAAAA-2222-3333-4444-555555555555",
		MICROSOFT_OAUTH_CLIENT_SECRET: "env-secret",
	};
	assert.equal((await microsoftClientStatus(fromEnv, ORIGIN)).source, "env");
	assert.equal((await resolveMicrosoftClient(fromEnv)).clientId, "aaaaaaaa-2222-3333-4444-555555555555");
	// A different key cannot open it, and says so.
	const otherKey = { ...env, APP_ENCRYPTION_KEY: "another-invented-key-0123456789abcdef-xyz" };
	assert.equal((await microsoftClientStatus(otherKey, ORIGIN)).unreadable, true);
	assert.equal(await resolveMicrosoftClient(otherKey), null);
});

test("Sign in with Microsoft connects the account with XOAUTH2, the refresh token sealed, sending verified", async (t) => {
	const { db, env, oauth, imap, smtp } = await setup(t);
	const { url, params } = await signIn(env);
	// PKCE and the state go to Microsoft; the verifier and the state themselves are never stored in the clear.
	assert.equal(url.searchParams.get("code_challenge_method"), "S256");
	assert.equal(url.searchParams.get("login_hint"), ADDRESS);
	const stateRow = db.db.prepare("SELECT * FROM oauth_states").get();
	assert.notEqual(stateRow.state_hash, url.searchParams.get("state"));
	assert.match(stateRow.code_verifier, /^enc:v1:/);

	const outcome = await completeMicrosoftSignIn(env, owner, params);
	assert.equal(outcome.ok, true, JSON.stringify(outcome));
	assert.equal(outcome.reconnected, false);
	assert.equal(db.db.prepare("SELECT count(*) AS n FROM oauth_states").get().n, 0);
	const row = accountRow(db);
	assert.equal(row.auth_kind, "oauth_microsoft");
	assert.equal(row.preset, "microsoft");
	assert.equal(row.address, ADDRESS);
	assert.equal(row.username, ADDRESS);
	assert.equal(row.imap_host, "outlook.office365.com");
	assert.equal(row.smtp_host, "smtp.office365.com");
	assert.equal(row.smtp_port, 587);
	assert.match(row.secret, /^enc:v1:/);
	assert.match(row.oauth_access_token, /^enc:v1:/);
	assert.ok(!row.secret.includes("rt-") && !row.oauth_access_token.includes("at-"));
	assert.equal(row.oauth_subject, "oid-1");
	assert.ok(row.oauth_expires_at > Date.now() / 1000 + 3000);
	// IMAP and SMTP both signed in with XOAUTH2, over TLS.
	assert.ok(imap.commands.some((entry) => /AUTHENTICATE XOAUTH2 /.test(entry.line) && entry.encrypted));
	assert.ok(smtp.auths.some((entry) => entry.method === "XOAUTH2" && entry.username === ADDRESS && entry.secure));

	const [view] = await listExternalAccounts(env, "owner");
	assert.equal(view.authKind, "oauth_microsoft");
	assert.equal(view.status, "active");
	assert.equal(view.hasPassword, true);
	assert.equal(view.sending.block, null);
	assert.equal(view.sending.providerSavesSent, true);
	const json = JSON.stringify(view);
	assert.ok(!/rt-|at-|enc:v1/.test(json));

	// The state was used: the same callback again, or another user's, connects nothing.
	assert.deepEqual(await completeMicrosoftSignIn(env, owner, params), { ok: false, reason: "expired" });
	const second = await signIn(env);
	assert.deepEqual(await completeMicrosoftSignIn(env, other, second.params), { ok: false, reason: "expired" });
	// Connecting the same address again is refused.
	const third = await signIn(env);
	assert.deepEqual(await completeMicrosoftSignIn(env, owner, third.params), { ok: false, reason: "address_taken" });
	assert.equal(oauth.requests.filter((entry) => entry.kind === "token").length, 2);
});

test("a refused or cancelled sign-in connects nothing and says why", async (t) => {
	const { db, env, oauth } = await setup(t);
	oauth.denyNext();
	assert.deepEqual(await completeMicrosoftSignIn(env, owner, (await signIn(env)).params), {
		ok: false,
		reason: "cancelled",
	});
	oauth.denyNext("access_denied", "AADSTS65001: The user or administrator has not consented to use the application.");
	assert.deepEqual(await completeMicrosoftSignIn(env, owner, (await signIn(env)).params), {
		ok: false,
		reason: "admin_consent",
	});
	oauth.failNextToken(400, { error: "invalid_grant", error_description: "AADSTS54005: code already redeemed" });
	assert.deepEqual(await completeMicrosoftSignIn(env, owner, (await signIn(env)).params), {
		ok: false,
		reason: "token",
	});
	// A wrong Kite password stops it before Microsoft is asked.
	const wrong = await refusal(
		startMicrosoftSignIn(env, owner, { mailboxId: "mailbox-a", kitePassword: "nope" }, ORIGIN),
	);
	assert.equal(wrong.code, "KITE_PASSWORD");
	assert.equal(db.db.prepare("SELECT count(*) AS n FROM external_accounts").get().n, 0);
});

test("tokens are refreshed before they expire, rotated, stored once, and used for sync, sending and imports", async (t) => {
	const { db, env, oauth, accessTokens } = await setup(t);
	await completeMicrosoftSignIn(env, owner, (await signIn(env)).params);
	const id = accountRow(db).id;
	const first = accessTokens[ADDRESS];
	// Cached: no token request.
	const before = oauth.requests.length;
	assert.equal(await oauthAccessToken(env, id), first);
	assert.equal(oauth.requests.length, before);

	// Four minutes before expiry it is refreshed: a new access token, a rotated refresh token, the version bumped once.
	db.db.prepare("UPDATE external_accounts SET oauth_expires_at = ?").run(Math.floor(Date.now() / 1000) + 240);
	const state = await readTokenState(env, id);
	const [a, b] = await Promise.all([oauthAccessToken(env, id), oauthAccessToken(env, id)]);
	assert.notEqual(a, first);
	assert.ok(a.startsWith("at-") && b.startsWith("at-"));
	const after = await readTokenState(env, id);
	assert.equal(after.version, state.version + 1);
	assert.notEqual(after.sealedRefreshToken, state.sealedRefreshToken);
	// A refresh that lost the race stores nothing.
	assert.equal(
		await storeRefreshedTokens(
			env,
			id,
			state.version,
			{ sealedRefreshToken: null, sealedAccessToken: "x", expiresAt: new Date(), scopes: "" },
			new Date(),
		),
		false,
	);

	// Sync signs in with the current token; a token the server no longer takes is refreshed once and tried again.
	const row = db.db.prepare("SELECT * FROM external_accounts").get();
	const account = {
		id: row.id,
		authKind: row.auth_kind,
		secret: row.secret,
		imapHost: row.imap_host,
		imapPort: row.imap_port,
		imapSecurity: row.imap_security,
		username: row.username,
	};
	delete accessTokens[ADDRESS];
	const session = await openSession(env, account, undefined);
	assert.ok((await session.examine("INBOX")).uidValidity);
	await session.close();

	// Imports get an XOAUTH2 login from core, never the refresh token.
	db.db.exec(
		`INSERT INTO import_jobs (id, user_id, mailbox_id, label, destination, host, port, secure, username, password, folder, status, external_account_id, created_at, updated_at) VALUES ('job-1', 'owner', 'mailbox-a', 'Outlook', '{"type":"inbox"}', '', 993, 1, '', '', 'INBOX', 'pending', '${id}', 1, 1)`,
	);
	const login = await externalSourceLogin(env, CTX, "import", { jobId: "job-1" });
	assert.equal(login.ok, true, JSON.stringify(login));
	assert.deepEqual(Object.keys(login.login.auth).sort(), ["accessToken", "kind", "user"]);
	assert.equal(login.login.auth.kind, "xoauth2");
	assert.equal(login.login.auth.user, ADDRESS);

	// Test connection works with the saved sign-in.
	const tested = await retestExternalAccount(env, owner, id);
	assert.equal(tested.problem, null);
});

test("a revoked sign-in stops the account at Sign-in failed, and Reconnect with the same account fixes it", async (t) => {
	const { db, env, oauth } = await setup(t);
	await completeMicrosoftSignIn(env, owner, (await signIn(env)).params);
	const id = accountRow(db).id;
	oauth.revokeAll();
	db.db.prepare("UPDATE external_accounts SET oauth_expires_at = 0").run();
	const error = await refusal(oauthAccessToken(env, id));
	assert.ok(error instanceof CredentialUnavailableError);
	assert.equal(error.kind, "auth");
	assert.match(error.message, /Reconnect the account \(invalid_grant, AADSTS70008\)/);
	const row = db.db.prepare("SELECT * FROM external_accounts").get();
	const syncError = await refusal(
		openSession(
			env,
			{
				id,
				authKind: row.auth_kind,
				secret: row.secret,
				imapHost: row.imap_host,
				imapPort: row.imap_port,
				imapSecurity: row.imap_security,
				username: row.username,
			},
			undefined,
		),
	);
	assert.ok(syncError instanceof SyncRefusedError);
	assert.equal(syncError.problem, "auth");
	const tested = await retestExternalAccount(env, owner, id);
	assert.equal(tested.problem.kind, "auth");
	assert.equal(tested.account.status, "auth_failed");

	// Microsoft away is not a reason to stop the account.
	oauth.failNextToken(503, { error: "temporarily_unavailable" });
	const away = await refusal(oauthAccessToken(env, id, { forceRefresh: true }));
	assert.equal(away.kind, "transient");

	// Reconnecting as another Microsoft account is refused; as the same one, the account is active again.
	oauth.setAccount({ address: "someone-else@outlook.test", oid: "oid-2" });
	assert.deepEqual(await completeMicrosoftSignIn(env, owner, (await signIn(env, owner, { accountId: id })).params), {
		ok: false,
		reason: "different_account",
	});
	oauth.setAccount({ address: ADDRESS, oid: "oid-1" });
	const again = await completeMicrosoftSignIn(env, owner, (await signIn(env, owner, { accountId: id })).params);
	assert.deepEqual(again, { ok: true, accountId: id, reconnected: true });
	assert.equal(accountRow(db).status, "active");
	assert.ok(await oauthAccessToken(env, id));
});

test("an SMTP server that refuses the token answers 535 after its JSON challenge, and the token stays out of errors", async (t) => {
	const { env } = await setup(t);
	const error = await refusal(
		openSmtpSession(env, {
			host: "smtp.office365.com",
			port: 587,
			security: "starttls",
			username: ADDRESS,
			password: "",
			accessToken: "at-refused",
		}),
	);
	assert.ok(error instanceof SmtpReplyError);
	assert.equal(error.authFailed, true);
	assert.ok(!error.message.includes("at-refused"));
});

test("backups and erased credentials never keep a token", async (t) => {
	const { db, env } = await setup(t);
	await completeMicrosoftSignIn(env, owner, (await signIn(env)).params);
	const redacted = redactBackupRow("external_accounts", accountRow(db));
	assert.equal(redacted.secret, "");
	assert.equal(redacted.oauth_access_token, null);
	db.db.prepare("UPDATE external_accounts SET suspended_at = 1").run();
	assert.equal(await eraseIdleExternalCredentials(env, new Date()), 1);
	const row = accountRow(db);
	assert.equal(row.secret, "");
	assert.equal(row.oauth_access_token, null);
	assert.equal(row.status, "disabled");
});
