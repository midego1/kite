import assert from "node:assert/strict";
import { join } from "node:path";
import test, { after } from "node:test";
import { sampleMessage, startFakeImap } from "./support/fake-imap.mjs";
import { startFakeGoogleOAuth } from "./support/fake-google-oauth.mjs";
import { startFakeSmtp } from "./support/fake-smtp.mjs";
import { bundleModules, root } from "./support/modules-bundle.mjs";
import { createTestCertificate } from "./support/test-certificate.mjs";

// Sign in with Google (spec §15.7) through the Node connector against fakes of Google's token endpoint and Gmail's
// IMAP (993) and SMTP (465) servers, on SQLite: the owner's OAuth client (checked, sealed, never answered, the
// environment winning), the flow with PKCE and a single-use state, the ID token's checks end to end, connecting and
// reconnecting by `sub` and address, switching a Gmail account between an app password and Google sign-in, refresh
// with compare-and-swap (Google keeps the refresh token), a revoked sign-in, and the token kept out of backups.

const {
	createTcpConnect,
	SqliteDatabase,
	applyMigrations,
	hashPassword,
	setInstallEnabled,
	saveGoogleClient,
	validateGoogleClient,
	googleClientStatus,
	resolveGoogleClient,
	startOAuthSignIn,
	completeOAuthSignIn,
	oauthAccessToken,
	CredentialUnavailableError,
	storeRefreshedTokens,
	readTokenState,
	listExternalAccounts,
	retestExternalAccount,
	updateExternalAccount,
	connectExternalAccount,
	accountCredential,
	externalSourceLogin,
	redactBackupRow,
} = await bundleModules("kite-external-google-oauth-node-", [
	["createTcpConnect", "server/runtime/tcp-connect.ts"],
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
	["hashPassword", "src/lib/auth/password.ts"],
	["setInstallEnabled", "src/lib/external-accounts/settings.ts"],
	[
		"saveGoogleClient, validateGoogleClient, googleClientStatus, resolveGoogleClient",
		"src/lib/external-accounts/oauth-google-client.ts",
	],
	["startOAuthSignIn, completeOAuthSignIn", "src/lib/external-accounts/oauth-flow.ts"],
	["oauthAccessToken, CredentialUnavailableError", "src/lib/external-accounts/oauth-tokens.ts"],
	["storeRefreshedTokens, readTokenState", "src/lib/external-accounts/oauth-store.ts"],
	[
		"listExternalAccounts, retestExternalAccount, updateExternalAccount, connectExternalAccount",
		"src/lib/external-accounts/service.ts",
	],
	["accountCredential", "src/lib/external-accounts/credential.ts"],
	["externalSourceLogin", "src/lib/external-accounts/source-login.ts"],
	["redactBackupRow", "src/lib/backups/external-accounts-utils.ts"],
]);

const ADDRESS = "someone@gmail.com";
const SUB = "110000000000000000001";
const KITE_PASSWORD = "kite-password-1";
const KEY = "test-only-invented-encryption-key-0123456789abcdef";
const ORIGIN = "http://kite.test";
const tls = createTestCertificate(["imap.gmail.com", "smtp.gmail.com"]);
const CTX = { viewer: null, requestId: "r", locale: "en", timeZone: "UTC", grants: ["import.run"], trigger: "queue" };

const previousEnv = globalThis.__kiteNodeEnv;
after(() => {
	globalThis.__kiteNodeEnv = previousEnv;
});

const owner = { id: "owner", role: "user", passwordHash: hashPassword(KITE_PASSWORD) };
const other = { id: "other", role: "user", passwordHash: hashPassword(KITE_PASSWORD) };

/** Google's token endpoint, Gmail's IMAP (993) and SMTP (465) fakes, and a migrated database with two users. */
async function setup(t, { saveClient = true, hostedDomain = null } = {}) {
	const accessTokens = {};
	const oauth = await startFakeGoogleOAuth({
		account: { address: ADDRESS, sub: SUB },
		onAccessToken: (address, token) => {
			accessTokens[address] = token;
		},
	});
	const users = { [ADDRESS]: "app-password", "ann@example.com": "app-password" };
	const imap = await startFakeImap({
		tls,
		implicitTls: true,
		saslIr: true,
		authPlain: true,
		users,
		accessTokens,
		folders: { INBOX: [sampleMessage(1, { subject: "Before connecting" })], Sent: [] },
	});
	t.after(() => Promise.all([oauth.close(), imap.close()]));
	const smtp = await startFakeSmtp({ tls, implicitTls: true, authMethods: ["PLAIN", "XOAUTH2"], users, accessTokens });
	t.after(() => smtp.close());
	const db = new SqliteDatabase(":memory:");
	t.after(() => db.db.close());
	await applyMigrations(db, join(root, "drizzle/migrations"));
	const hash = hashPassword(KITE_PASSWORD);
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('owner', 'owner@example.org', '${hash}', 'Owner', 1);
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('other', 'other@example.org', '${hash}', 'Other', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.org', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'a', 'personal', 1);
	`);
	const connect = createTcpConnect({ ca: tls.cert, resolve: async () => ["127.0.0.1"], allowLoopback: true });
	const ports = { 993: imap.port, 465: smtp.port };
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
		await saveGoogleClient(env, { clientId: oauth.clientId, clientSecret: oauth.clientSecret, hostedDomain });
	return { db, env, oauth, imap, smtp, accessTokens };
}

/** Starts a Google sign-in, lets the fake consent, and answers the callback's query, as the browser would carry it. */
async function signIn(env, actor = owner, body = {}) {
	const { url } = await startOAuthSignIn(
		env,
		actor,
		"google",
		{ mailboxId: "mailbox-a", kitePassword: KITE_PASSWORD, address: ADDRESS, preset: "gmail", ...body },
		ORIGIN,
	);
	const response = await fetch(url, { redirect: "manual" });
	assert.equal(response.status, 302);
	const callback = new URL(response.headers.get("location"));
	assert.equal(callback.origin + callback.pathname, `${ORIGIN}/api/external-accounts/oauth/callback`);
	return { url: new URL(url), params: callback.searchParams };
}

const accountRow = (db) => db.db.prepare("SELECT * FROM external_accounts").get();
const failed = (reason) => ({ ok: false, reason, provider: "google" });

async function refusal(promise) {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	assert.fail("expected a refusal");
}

test("the owner's OAuth client is checked with Google, stored sealed, never answered, and the environment wins", async (t) => {
	const { db, env, oauth } = await setup(t, { saveClient: false });
	const redirect = `${ORIGIN}/api/external-accounts/oauth/callback`;
	const client = { clientId: oauth.clientId, clientSecret: oauth.clientSecret, hostedDomain: null };
	const wrong = await validateGoogleClient(env, { ...client, clientSecret: "wrong" }, redirect);
	assert.equal(wrong.verdict, "rejected");
	assert.match(wrong.error, /refused the client secret/);
	const unknown = await validateGoogleClient(
		env,
		{ ...client, clientId: "9-other.apps.googleusercontent.com" },
		redirect,
	);
	assert.match(unknown.error, /knows no OAuth client/);
	assert.deepEqual(await validateGoogleClient(env, client, redirect), { verdict: "ok" });
	assert.deepEqual(await validateGoogleClient(env, client, redirect, async () => new Response("", { status: 503 })), {
		verdict: "unverified",
	});

	const withoutKey = await refusal(saveGoogleClient({ ...env, APP_ENCRYPTION_KEY: "" }, client));
	assert.equal(withoutKey.code, "NO_KEY");
	assert.equal(await resolveGoogleClient(env), null);
	await saveGoogleClient(env, client);
	const stored = db.db
		.prepare("SELECT oauth_google_client AS value FROM app_settings WHERE id = 'default'")
		.get().value;
	assert.match(stored, /^enc:v1:/);
	assert.ok(!stored.includes(oauth.clientSecret));
	assert.deepEqual(await resolveGoogleClient(env), client);
	const status = await googleClientStatus(env, ORIGIN);
	assert.equal(status.source, "settings");
	assert.equal(status.redirectUri, redirect);
	assert.ok(!JSON.stringify(status).includes(oauth.clientSecret));
	// The Microsoft registration is separate: saving Google's never touches it.
	assert.equal(db.db.prepare("SELECT oauth_microsoft_client AS v FROM app_settings").get().v, null);

	const fromEnv = {
		...env,
		GOOGLE_OAUTH_CLIENT_ID: ` ${oauth.clientId} `,
		GOOGLE_OAUTH_CLIENT_SECRET: "env-secret",
		GOOGLE_OAUTH_HOSTED_DOMAIN: "Example.com",
	};
	assert.deepEqual(await resolveGoogleClient(fromEnv), {
		clientId: oauth.clientId,
		clientSecret: "env-secret",
		hostedDomain: "example.com",
	});
	assert.equal((await googleClientStatus(fromEnv, ORIGIN)).source, "env");
	// Variables that are set but not valid turn sign-in off instead of falling back to the saved client, which would
	// drop the domain restriction they meant.
	const invalidEnv = { ...fromEnv, GOOGLE_OAUTH_HOSTED_DOMAIN: "not a domain" };
	assert.equal(await resolveGoogleClient(invalidEnv), null);
	const invalidStatus = await googleClientStatus(invalidEnv, ORIGIN);
	assert.equal(invalidStatus.source, "env");
	assert.equal(invalidStatus.clientId, null);
	// A key that cannot open the saved client says so instead of failing.
	const otherKey = await googleClientStatus(
		{ ...env, APP_ENCRYPTION_KEY: "another-invented-key-0123456789abcdef" },
		ORIGIN,
	);
	assert.equal(otherKey.unreadable, true);
	assert.equal(otherKey.source, null);
});

test("Sign in with Google connects a Gmail account with XOAUTH2, the refresh token sealed, sending verified", async (t) => {
	const { db, env, oauth, imap, smtp } = await setup(t);
	const { url, params } = await signIn(env);
	assert.equal(url.origin + url.pathname, `${oauth.origin}/google/o/oauth2/v2/auth`);
	assert.equal(url.searchParams.get("code_challenge_method"), "S256");
	assert.equal(url.searchParams.get("access_type"), "offline");
	assert.equal(url.searchParams.get("prompt"), "consent");
	assert.equal(url.searchParams.get("scope"), "https://mail.google.com/ openid email");
	assert.equal(url.searchParams.get("login_hint"), ADDRESS);
	const stateRow = db.db.prepare("SELECT * FROM oauth_states").get();
	assert.equal(stateRow.provider, "google");
	assert.notEqual(stateRow.state_hash, url.searchParams.get("state"));
	assert.match(stateRow.code_verifier, /^enc:v1:/);

	const outcome = await completeOAuthSignIn(env, owner, params);
	assert.equal(outcome.ok, true, JSON.stringify(outcome));
	assert.equal(outcome.provider, "google");
	assert.equal(outcome.reconnected, false);
	const row = accountRow(db);
	assert.equal(row.auth_kind, "oauth_google");
	assert.equal(row.preset, "gmail");
	assert.equal(row.address, ADDRESS);
	assert.equal(row.imap_host, "imap.gmail.com");
	assert.equal(row.smtp_host, "smtp.gmail.com");
	assert.equal(row.smtp_port, 465);
	assert.equal(row.trust_auth_results, 1, "Gmail's own Authentication-Results, as with an app password");
	assert.equal(row.append_sent, 0);
	assert.match(row.secret, /^enc:v1:/);
	assert.ok(!row.secret.includes("1//") && !row.oauth_access_token.includes("ya29."));
	assert.equal(row.oauth_subject, SUB);
	assert.ok(imap.commands.some((entry) => /AUTHENTICATE XOAUTH2 /.test(entry.line) && entry.encrypted));
	assert.ok(smtp.auths.some((entry) => entry.method === "XOAUTH2" && entry.username === ADDRESS && entry.secure));
	const [view] = await listExternalAccounts(env, "owner");
	assert.equal(view.authKind, "oauth_google");
	assert.equal(view.status, "active");
	assert.ok(!/1\/\/|ya29\.|enc:v1/.test(JSON.stringify(view)));

	// The state was used: the same callback again, or another user's, connects nothing and names no provider.
	assert.deepEqual(await completeOAuthSignIn(env, owner, params), { ok: false, reason: "expired", provider: null });
	const second = await signIn(env);
	assert.deepEqual(await completeOAuthSignIn(env, other, second.params), {
		ok: false,
		reason: "expired",
		provider: null,
	});
	assert.deepEqual(await completeOAuthSignIn(env, owner, (await signIn(env)).params), failed("address_taken"));

	// Imports get an XOAUTH2 login from core, never the refresh token.
	db.db.exec(
		`INSERT INTO import_jobs (id, user_id, mailbox_id, label, destination, host, port, secure, username, password, folder, status, external_account_id, created_at, updated_at) VALUES ('job-1', 'owner', 'mailbox-a', 'Gmail', '{"type":"inbox"}', '', 993, 1, '', '', 'INBOX', 'pending', '${row.id}', 1, 1)`,
	);
	const login = await externalSourceLogin(env, CTX, "import", { jobId: "job-1" });
	assert.equal(login.ok, true, JSON.stringify(login));
	assert.equal(login.login.auth.kind, "xoauth2");
	assert.equal(login.login.auth.user, ADDRESS);
	assert.equal((await retestExternalAccount(env, owner, row.id)).problem, null);
});

test("an ID token Kite must not trust connects nothing: wrong issuer or audience, unverified, expired, another domain", async (t) => {
	const { db, env, oauth } = await setup(t);
	// Many attempts in a row: the connection-attempt limit (10 per 10 minutes) is not what this test is about.
	const attempt = async () => {
		db.db.exec("DELETE FROM audit_logs");
		return completeOAuthSignIn(env, owner, (await signIn(env)).params);
	};
	for (const change of [
		(claims) => ({ ...claims, iss: "https://evil.example" }),
		(claims) => ({ ...claims, aud: "999-another.apps.googleusercontent.com" }),
		(claims) => ({ ...claims, azp: "999-another.apps.googleusercontent.com" }),
		(claims) => ({ ...claims, email_verified: false }),
		(claims) => ({ ...claims, exp: Math.floor(Date.now() / 1000) - 3600 }),
		(claims) => ({ ...claims, sub: undefined }),
	]) {
		oauth.setIdTokenClaims(change);
		assert.deepEqual(await attempt(), failed("no_address"));
	}
	assert.equal(db.db.prepare("SELECT count(*) AS n FROM external_accounts").get().n, 0);
	oauth.setIdTokenClaims((claims) => claims);

	// The user unticked Gmail on Google's consent screen, or Google kept the refresh token back.
	oauth.setScope("openid https://www.googleapis.com/auth/userinfo.email");
	assert.deepEqual(await attempt(), failed("scopes"));
	oauth.setScope("https://mail.google.com/ openid https://www.googleapis.com/auth/userinfo.email");
	oauth.setOmitRefreshToken(true);
	assert.deepEqual(await attempt(), failed("no_refresh_token"));
	oauth.setOmitRefreshToken(false);
	// Cancelled at Google, blocked by a Workspace policy, or a code Google no longer redeems.
	oauth.denyNext("access_denied");
	assert.deepEqual(await attempt(), failed("cancelled"));
	oauth.denyNext("admin_policy_enforced");
	assert.deepEqual(await attempt(), failed("admin_consent"));
	oauth.failNextToken(400, { error: "invalid_grant", error_description: "Bad Request" });
	assert.deepEqual(await attempt(), failed("token"));
	assert.equal(db.db.prepare("SELECT count(*) AS n FROM external_accounts").get().n, 0);
});

test("with a Workspace domain set, only that domain's accounts connect, as Google Workspace", async (t) => {
	const { db, env, oauth } = await setup(t, { hostedDomain: "example.com" });
	const first = await signIn(env);
	assert.equal(first.url.searchParams.get("hd"), "example.com");
	assert.deepEqual(await completeOAuthSignIn(env, owner, first.params), failed("wrong_domain"));
	oauth.setAccount({ address: "ann@example.com", sub: "120000000000000000002", hd: "other.example" });
	assert.deepEqual(
		await completeOAuthSignIn(env, owner, (await signIn(env, owner, { address: "ann@example.com" })).params),
		failed("wrong_domain"),
	);
	oauth.setAccount({ address: "ann@example.com", sub: "120000000000000000002", hd: "example.com" });
	const outcome = await completeOAuthSignIn(
		env,
		owner,
		(await signIn(env, owner, { address: "ann@example.com", preset: "google_workspace" })).params,
	);
	assert.equal(outcome.ok, true, JSON.stringify(outcome));
	assert.equal(accountRow(db).preset, "google_workspace");
});

test("refresh: the cached token until five minutes before expiry, then one refresh that keeps Google's refresh token", async (t) => {
	const { db, env, oauth } = await setup(t);
	await completeOAuthSignIn(env, owner, (await signIn(env)).params);
	const id = accountRow(db).id;
	const first = await oauthAccessToken(env, id);
	const tokenRequests = () => oauth.requests.filter((entry) => entry.kind === "token").length;
	const before = tokenRequests();
	assert.equal(await oauthAccessToken(env, id), first);
	assert.equal(tokenRequests(), before);

	db.db.prepare("UPDATE external_accounts SET oauth_expires_at = ?").run(Math.floor(Date.now() / 1000) + 240);
	const state = await readTokenState(env, id);
	assert.equal(state.authKind, "oauth_google");
	const [a, b] = await Promise.all([oauthAccessToken(env, id), oauthAccessToken(env, id)]);
	assert.ok(a.startsWith("ya29.") && b.startsWith("ya29.") && a !== first);
	const refreshed = await readTokenState(env, id);
	assert.equal(refreshed.version, state.version + 1, "only one of two refreshes at once stores");
	assert.equal(refreshed.sealedRefreshToken, state.sealedRefreshToken, "Google does not rotate the refresh token");
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
	// A refresh asks for no scopes, so Google renews exactly what the user granted.
	assert.ok(oauth.requests.some((entry) => entry.grant === "refresh_token" && entry.scope === null));
	assert.deepEqual(Object.keys(await accountCredential(env, { id, authKind: "oauth_google", secret: "x" })).sort(), [
		"accessToken",
		"oauthProvider",
		"password",
	]);
});

test("a revoked Google sign-in stops the account at Sign-in failed, and Reconnect must be the same Google user", async (t) => {
	const { db, env, oauth } = await setup(t);
	await completeOAuthSignIn(env, owner, (await signIn(env)).params);
	const id = accountRow(db).id;
	oauth.revokeAll();
	db.db.prepare("UPDATE external_accounts SET oauth_expires_at = 0").run();
	const error = await refusal(oauthAccessToken(env, id));
	assert.ok(error instanceof CredentialUnavailableError);
	assert.equal(error.kind, "auth");
	assert.equal(error.message, "Google sign-in expired or was revoked. Reconnect the account (invalid_grant).");
	const tested = await retestExternalAccount(env, owner, id);
	assert.equal(tested.problem.kind, "auth");
	assert.equal(tested.account.status, "auth_failed");

	// Google away is not a reason to stop the account.
	oauth.failNextToken(503, { error: "backendError" });
	assert.equal((await refusal(oauthAccessToken(env, id, { forceRefresh: true }))).kind, "transient");

	// Another address, or the same address as another Google user (a deleted and re-created account), is refused.
	oauth.setAccount({ address: "someone-else@gmail.com", sub: SUB });
	assert.deepEqual(
		await completeOAuthSignIn(env, owner, (await signIn(env, owner, { accountId: id })).params),
		failed("different_account"),
	);
	oauth.setAccount({ address: ADDRESS, sub: "119999999999999999999" });
	assert.deepEqual(
		await completeOAuthSignIn(env, owner, (await signIn(env, owner, { accountId: id })).params),
		failed("different_account"),
	);
	oauth.setAccount({ address: ADDRESS, sub: SUB });
	const before = await readTokenState(env, id);
	const again = await completeOAuthSignIn(env, owner, (await signIn(env, owner, { accountId: id })).params);
	assert.deepEqual(again, { ok: true, provider: "google", accountId: id, reconnected: true });
	assert.equal(accountRow(db).status, "active");
	const after = await readTokenState(env, id);
	assert.ok(after.version > before.version, "a refresh that started before the reconnect cannot store over it");
	assert.ok(await oauthAccessToken(env, id));

	// Another user cannot reconnect it: the account is not theirs, and nothing starts.
	const asOther = await refusal(
		startOAuthSignIn(env, other, "google", { accountId: id, kitePassword: KITE_PASSWORD }, ORIGIN),
	);
	assert.equal(asOther.status, 404);
});

test("a Gmail account switches from an app password to Google sign-in and back", async (t) => {
	const { db, env } = await setup(t);
	const view = await connectExternalAccount(env, owner, {
		address: ADDRESS,
		preset: "gmail",
		mailboxId: "mailbox-a",
		password: "app-password",
		kitePassword: KITE_PASSWORD,
	});
	assert.equal(accountRow(db).auth_kind, "password");
	// The password account keeps working as before.
	assert.deepEqual(await accountCredential(env, { id: view.id, authKind: "password", secret: accountRow(db).secret }), {
		password: "app-password",
	});

	const switched = await completeOAuthSignIn(env, owner, (await signIn(env, owner, { accountId: view.id })).params);
	assert.deepEqual(switched, { ok: true, provider: "google", accountId: view.id, reconnected: true });
	let row = accountRow(db);
	assert.equal(row.auth_kind, "oauth_google");
	assert.equal(row.oauth_subject, SUB);
	assert.ok(!row.secret.includes("app-password"));
	const credential = await accountCredential(env, { id: view.id, authKind: row.auth_kind, secret: row.secret });
	assert.equal(credential.password, "");
	assert.equal(credential.oauthProvider, "google");
	assert.ok(credential.accessToken.startsWith("ya29."));

	// Back to an app password: the sign-in is forgotten and a refresh in flight can no longer store.
	const before = await readTokenState(env, view.id);
	await updateExternalAccount(env, owner, view.id, { password: "app-password", kitePassword: KITE_PASSWORD });
	row = accountRow(db);
	assert.equal(row.auth_kind, "password");
	assert.equal(row.oauth_subject, null);
	assert.equal(row.oauth_access_token, null);
	const tokens = { sealedRefreshToken: "late", sealedAccessToken: "late", expiresAt: new Date(), scopes: "" };
	assert.equal(await storeRefreshedTokens(env, view.id, before.version, tokens, new Date()), false);
	const current = await readTokenState(env, view.id);
	assert.equal(await storeRefreshedTokens(env, view.id, current.version, tokens, new Date()), false);
	assert.deepEqual(await accountCredential(env, { id: view.id, authKind: row.auth_kind, secret: row.secret }), {
		password: "app-password",
	});
});

test("a Google account's tokens never reach a backup", async (t) => {
	const { db, env } = await setup(t);
	await completeOAuthSignIn(env, owner, (await signIn(env)).params);
	const redacted = redactBackupRow("external_accounts", accountRow(db));
	assert.equal(redacted.secret, "");
	assert.equal(redacted.oauth_access_token ?? null, null);
});
