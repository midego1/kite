import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { copyMigrationsBefore } from "./support/module-database.mjs";

/**
 * MCP over OAuth 2.1 (migration 0106): redirect URI and registration rules, PKCE S256, the authorization request's
 * checks, token hashing, single-use codes, refresh rotation with replay detection, expiry, the audience binding to
 * `/mcp`, revocation, per-scope tool filtering through the same principal as MCP keys, the pruning, backups and the
 * fallbacks before the migration.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(root, "drizzle/migrations");
const bundleDirectory = makeBundleDirectory("kite-mcp-oauth-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export * from "./src/lib/mcp/oauth/utils.ts";
			export * from "./src/lib/mcp/oauth/service.ts";
			export { listGrants } from "./src/lib/mcp/oauth/store.ts";
			export { readAuthorization } from "./src/lib/mcp/oauth/consent.ts";
			export { OAUTH_SUPPORTED_SCOPES } from "./src/lib/mcp/oauth/http.ts";
			export { authenticateMcpRequest } from "./src/lib/mcp/auth.ts";
			export { authenticateApiKeyValue } from "./src/lib/api/key-auth.ts";
			export { createKiteMcpHandler } from "./src/lib/mcp/server.ts";
			export { runDatabasePruning } from "./src/lib/maintenance/pruning.ts";
			export { assertBackupTablesCoverDatabase, exportDatabaseRecords } from "./src/lib/backups/export.ts";
			export { loginNextPath } from "./src/lib/auth/next-path-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "mcp-oauth-entry.ts",
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
	alias: {
		"next/headers": "next/headers.js",
		"next/server": "next/server.js",
		"cloudflare:workers": "./server/runtime/cloudflare-workers.ts",
	},
	logLevel: "silent",
});
const m = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);

const scratch = makeBundleDirectory("kite-mcp-oauth-dirs-");
after(() => rmSync(scratch, { recursive: true, force: true }));

const ISSUER = "https://kite.test";
const RESOURCE = `${ISSUER}/mcp`;
const REDIRECT = "http://127.0.0.1:43123/callback";
// RFC 7636 Appendix B.
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

async function fixture(t, dir = migrationsDir) {
	const database = new m.SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await m.applyMigrations(database, dir);
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES
			('user-1', 'owner@example.com', 'hash', 'Owner', 1),
			('user-2', 'other@example.com', 'hash', 'Other', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'user-1', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES
			('mailbox-1', 'user-1', 'domain-1', 'owner', 1),
			('mailbox-2', 'user-2', 'domain-1', 'other', 1);
	`);
	const env = {
		DB: database,
		BUCKET: { get: async () => null, put: async () => {}, delete: async () => {} },
		KITE_RUNTIME: "node",
	};
	globalThis.__kiteNodeEnv = env;
	return { database, env };
}

async function connect(env, { scopes = ["mcp:read"], mailboxIds = ["mailbox-1"], now = new Date() } = {}) {
	const client = await m.registerClient(env, { name: "Test client", redirectUris: [REDIRECT] }, now);
	const code = await m.createAuthorizationCode(
		env,
		{
			clientId: client.id,
			userId: "user-1",
			redirectUri: REDIRECT,
			codeChallenge: CHALLENGE,
			resource: RESOURCE,
			scopes,
			mailboxIds,
		},
		now,
	);
	return { client, code };
}

const exchange = (env, client, code, overrides = {}, now = new Date()) =>
	m.exchangeAuthorizationCode(
		env,
		{ clientId: client.id, code, redirectUri: REDIRECT, codeVerifier: VERIFIER, resource: RESOURCE, ...overrides },
		now,
	);

const bearer = (token) => new Request(RESOURCE, { method: "POST", headers: { Authorization: `Bearer ${token}` } });

async function rejects(promise, code) {
	await assert.rejects(promise, (error) => error instanceof m.OAuthError && error.code === code);
}

test("redirect URIs: https anywhere or http on loopback, no fragment, no user info, no private schemes", () => {
	for (const uri of [
		"https://claude.ai/api/mcp/auth_callback",
		"http://127.0.0.1:33418",
		"http://localhost:6274/oauth/callback",
		"http://[::1]:8080/cb",
		"https://example.com/cb?tenant=a",
	])
		assert.equal(m.isAllowedRedirectUri(uri), true, uri);
	for (const uri of [
		"http://example.com/cb",
		"http://127.0.0.1.example.com/cb",
		"https://example.com/cb#frag",
		"https://user:pass@example.com/cb",
		"cursor://anysphere.cursor-mcp/oauth/callback",
		"javascript:alert(1)",
		"https://example.com/c b",
		`https://example.com/${"a".repeat(1100)}`,
		"",
		42,
	])
		assert.equal(m.isAllowedRedirectUri(uri), false, String(uri));
});

test("registration takes public clients only, with sane limits, and cleans the self-chosen name", () => {
	const registered = m.parseClientRegistration({
		client_name: "  Claude\u0000 Desktop‮ ",
		redirect_uris: [REDIRECT, REDIRECT],
		token_endpoint_auth_method: "none",
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		logo_uri: "https://tracker.example/logo.png",
	});
	assert.deepEqual(registered, { name: "Claude Desktop", redirectUris: [REDIRECT] });
	assert.equal(m.parseClientRegistration({ redirect_uris: [REDIRECT] }).name, "MCP client");
	assert.equal(m.parseClientRegistration({ client_name: "x".repeat(300), redirect_uris: [REDIRECT] }).name.length, 100);
	const refused = (body, code) =>
		assert.throws(
			() => m.parseClientRegistration(body),
			(error) => error.code === code,
		);
	refused(null, "invalid_client_metadata");
	refused({ redirect_uris: [] }, "invalid_redirect_uri");
	refused({ redirect_uris: ["http://evil.example/cb"] }, "invalid_redirect_uri");
	refused({ redirect_uris: Array.from({ length: 6 }, (_, i) => `https://a.example/${i}`) }, "invalid_redirect_uri");
	refused({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_basic" }, "invalid_client_metadata");
	refused({ redirect_uris: [REDIRECT], grant_types: ["implicit"] }, "invalid_client_metadata");
	refused({ redirect_uris: [REDIRECT], response_types: ["token"] }, "invalid_client_metadata");
	const response = m.registrationResponse({ id: "mcpc_x", ...registered }, new Date(5_000));
	assert.equal(response.token_endpoint_auth_method, "none");
	assert.equal(response.client_id_issued_at, 5);
	assert.equal("client_secret" in response, false);
});

test("PKCE is S256 only and checks the verifier against the challenge", async () => {
	assert.equal(await m.verifyPkce(VERIFIER, CHALLENGE), true);
	assert.equal(await m.verifyPkce(`${VERIFIER.slice(0, -1)}A`, CHALLENGE), false);
	assert.equal(await m.verifyPkce(CHALLENGE, CHALLENGE), false);
	assert.equal(await m.verifyPkce("short", CHALLENGE), false);
	assert.equal(await m.verifyPkce(undefined, CHALLENGE), false);
	assert.equal(m.authorizationServerMetadata(ISSUER, ["mcp:read"]).code_challenge_methods_supported.join(), "S256");
});

test("codes and tokens are random, prefixed and stored as their SHA-256", async () => {
	const token = m.randomOAuthToken(m.OAUTH_ACCESS_TOKEN_PREFIX);
	assert.match(token, /^kite_at_[A-Za-z0-9_-]{43}$/);
	assert.notEqual(token, m.randomOAuthToken(m.OAUTH_ACCESS_TOKEN_PREFIX));
	assert.equal(await m.hashOAuthToken(token), createHash("sha256").update(token).digest("hex"));
	assert.equal(m.constantTimeEqual("abc", "abc"), true);
	assert.equal(m.constantTimeEqual("abc", "abd"), false);
	assert.equal(m.constantTimeEqual("abc", "abcd"), false);
});

test("the authorization request: unknown clients and redirect URIs are shown, the rest goes back to the client", () => {
	const client = { id: "mcpc_1", name: "App", redirectUris: [REDIRECT] };
	const base = {
		client_id: "mcpc_1",
		redirect_uri: REDIRECT,
		response_type: "code",
		code_challenge: CHALLENGE,
		code_challenge_method: "S256",
		state: "xyz",
		resource: RESOURCE,
	};
	const check = (params, registration = client) =>
		m.checkAuthorizationRequest(new URLSearchParams(params), registration, RESOURCE, m.OAUTH_SUPPORTED_SCOPES);
	assert.equal(check(base, null).kind, "fatal");
	assert.equal(check({ ...base, redirect_uri: "http://127.0.0.1:43123/callback/" }).kind, "fatal");
	assert.equal(check({ ...base, redirect_uri: "https://evil.example/cb" }).kind, "fatal");
	const { redirect_uri: _omitted, ...withoutRedirect } = base;
	assert.equal(check(withoutRedirect).kind, "ok");
	const twoUris = { ...client, redirectUris: [REDIRECT, "https://app.example/cb"] };
	assert.equal(check(withoutRedirect, twoUris).kind, "fatal");
	const errorOf = (params) => {
		const result = check(params);
		assert.equal(result.kind, "redirect");
		assert.equal(result.state, "xyz");
		return result.error;
	};
	assert.equal(errorOf({ ...base, response_type: "token" }), "unsupported_response_type");
	assert.equal(errorOf({ ...base, code_challenge: "" }), "invalid_request");
	assert.equal(errorOf({ ...base, code_challenge_method: "plain" }), "invalid_request");
	assert.equal(errorOf({ ...base, resource: "https://other.test/mcp" }), "invalid_target");
	assert.equal(errorOf({ ...base, resource: `${ISSUER}/api/v1` }), "invalid_target");
	assert.equal(errorOf({ ...base, scope: "domains accounts" }), "invalid_scope");
	const ok = check({ ...base, scope: "mcp:draft unknown mcp:read" });
	assert.equal(ok.kind, "ok");
	assert.deepEqual(ok.request.scopes, ["mcp:read", "mcp:draft"]);
	assert.deepEqual(m.defaultCheckedScopes(ok.request.scopes), ["mcp:read"]);
	assert.deepEqual(m.defaultCheckedScopes(["mcp:draft"]), []);
	// No scope asked for: every supported one is on offer, admin scopes never.
	const all = check(base);
	assert.deepEqual(all.request.scopes, [...m.OAUTH_SUPPORTED_SCOPES]);
	assert.equal(all.request.scopes.includes("domains"), false);
	const back = new URL(
		m.authorizationRedirect("https://app.example/cb?keep=1", { code: "c", state: "s", iss: ISSUER }),
	);
	assert.deepEqual(Object.fromEntries(back.searchParams), { keep: "1", code: "c", state: "s", iss: ISSUER });
});

test("a parameter sent twice is refused before anything else", async (t) => {
	const { env } = await fixture(t);
	const params = new URLSearchParams("client_id=a&client_id=b&response_type=code");
	const { check } = await m.readAuthorization(env, params, ISSUER);
	assert.equal(check.kind, "fatal");
});

test("metadata names /mcp as the resource and this Kite as its authorization server", () => {
	const resource = m.protectedResourceMetadata(ISSUER, ["mcp:read"]);
	assert.equal(resource.resource, RESOURCE);
	assert.deepEqual(resource.authorization_servers, [ISSUER]);
	const server = m.authorizationServerMetadata(ISSUER, ["mcp:read"]);
	assert.equal(server.issuer, ISSUER);
	assert.equal(server.token_endpoint, `${ISSUER}/api/oauth/token`);
	assert.deepEqual(server.grant_types_supported, ["authorization_code", "refresh_token"]);
	assert.deepEqual(server.token_endpoint_auth_methods_supported, ["none"]);
	assert.equal(
		m.mcpAuthenticateHeader(ISSUER, true),
		`Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp", error="invalid_token"`,
	);
	assert.equal(m.oauthIssuer("https://mail.example.com/", "http://10.0.0.1:3000/mcp"), "https://mail.example.com");
	assert.equal(m.oauthIssuer(undefined, "http://localhost:3200/mcp"), "http://localhost:3200");
	assert.equal(m.resourceMatches(null, RESOURCE), true);
	assert.equal(m.resourceMatches(`${RESOURCE}/`, RESOURCE), true);
	assert.equal(m.resourceMatches(`${RESOURCE}?x=1`, RESOURCE), false);
});

test("sign-in only returns to the consent screen", () => {
	assert.equal(m.loginNextPath("/oauth/authorize?client_id=x"), "/oauth/authorize?client_id=x");
	assert.equal(m.loginNextPath("/oauth/authorize"), "/oauth/authorize");
	for (const value of ["//evil.example/oauth/authorize", "https://evil.example", "/inbox", "/oauth/authorizex", null])
		assert.equal(m.loginNextPath(value), null, String(value));
});

test("a code becomes a grant once, with the right client, redirect URI, verifier and resource", async (t) => {
	const { env, database } = await fixture(t);
	const { client, code } = await connect(env, { scopes: ["mcp:read", "mcp:draft"] });
	await rejects(exchange(env, client, code, { codeVerifier: undefined }), "invalid_grant");
	// That attempt used the code up: start again.
	const second = await connect(env, { scopes: ["mcp:read", "mcp:draft"] });
	const tokens = await exchange(env, second.client, second.code);
	assert.match(tokens.access_token, /^kite_at_/);
	assert.match(tokens.refresh_token, /^kite_rt_/);
	assert.equal(tokens.token_type, "Bearer");
	assert.equal(tokens.expires_in, 3600);
	assert.equal(tokens.scope, "mcp:read mcp:draft");
	// Only hashes are stored.
	const dump = JSON.stringify(database.db.prepare("SELECT * FROM mcp_oauth_tokens").all());
	assert.equal(dump.includes(tokens.access_token), false);
	assert.equal(dump.includes(tokens.refresh_token), false);
	assert.ok(dump.includes(await m.hashOAuthToken(tokens.access_token)));
	const [key] = database.db.prepare("SELECT * FROM api_keys WHERE kind = 'oauth'").all();
	assert.equal(key.name, "Test client");
	assert.equal(key.key_hash, "!");
	assert.deepEqual(JSON.parse(key.scopes), ["mcp:read", "mcp:draft"]);
	const principal = await m.authenticateMcpRequest(env, bearer(tokens.access_token), RESOURCE);
	assert.equal(principal.keyId, key.id);
	assert.equal(principal.user.id, "user-1");
	assert.deepEqual(principal.scopes, ["mcp:read", "mcp:draft"]);
	assert.deepEqual(principal.mailboxIds, ["mailbox-1"]);

	// A replayed code is refused and revokes what it was redeemed for (RFC 6749 §4.1.2).
	await rejects(exchange(env, second.client, second.code), "invalid_grant");
	assert.equal(await m.authenticateMcpRequest(env, bearer(tokens.access_token), RESOURCE), null);
});

test("an exchange is refused for another client, redirect URI or resource, or after the code expired", async (t) => {
	const { env } = await fixture(t);
	const other = await m.registerClient(env, { name: "Other", redirectUris: [REDIRECT] }, new Date());
	let flow = await connect(env);
	await rejects(exchange(env, other, flow.code), "invalid_grant");
	flow = await connect(env);
	await rejects(exchange(env, flow.client, flow.code, { redirectUri: `${REDIRECT}/` }), "invalid_grant");
	flow = await connect(env);
	await rejects(exchange(env, flow.client, flow.code, { resource: "https://other.test/mcp" }), "invalid_target");
	flow = await connect(env, { now: new Date(Date.now() - 3 * 60_000) });
	await rejects(exchange(env, flow.client, flow.code), "invalid_grant");
	await rejects(exchange(env, flow.client, undefined), "invalid_request");
});

test("tokens are bound to /mcp: another audience or the REST and JMAP key paths refuse them", async (t) => {
	const { env } = await fixture(t);
	const { client, code } = await connect(env);
	const tokens = await exchange(env, client, code);
	assert.equal(await m.authenticateMcpRequest(env, bearer(tokens.access_token), "https://other.test/mcp"), null);
	assert.equal(await m.authenticateMcpRequest(env, bearer(tokens.access_token), `${ISSUER}/api/v1`), null);
	assert.equal(await m.authenticateMcpRequest(env, bearer(tokens.refresh_token), RESOURCE), null);
	assert.equal(await m.authenticateApiKeyValue(env, tokens.access_token), null);
	assert.equal(await m.authenticateApiKeyValue(env, "oauth"), null);
});

test("an expired access token is refused", async (t) => {
	const { env, database } = await fixture(t);
	const { client, code } = await connect(env);
	const tokens = await exchange(env, client, code);
	database.db.prepare("UPDATE mcp_oauth_tokens SET expires_at = 1 WHERE kind = 'access'").run();
	assert.equal(await m.authenticateMcpRequest(env, bearer(tokens.access_token), RESOURCE), null);
});

test("refresh rotates both tokens, and a used refresh token presented again revokes the grant", async (t) => {
	const { env } = await fixture(t);
	const { client, code } = await connect(env);
	const first = await exchange(env, client, code);
	const refresh = (token, overrides = {}, now = new Date()) =>
		m.refreshTokens(
			env,
			{ clientId: client.id, refreshToken: token, resource: RESOURCE, scope: null, ...overrides },
			now,
		);
	await rejects(refresh(first.refresh_token, { scope: "mcp:read mcp:draft" }), "invalid_scope");
	await rejects(refresh(first.refresh_token, { resource: "https://other.test/mcp" }), "invalid_target");
	await rejects(refresh(first.refresh_token, { clientId: "mcpc_other" }), "invalid_grant");
	await rejects(refresh(first.access_token), "invalid_grant");
	const second = await refresh(first.refresh_token);
	assert.notEqual(second.refresh_token, first.refresh_token);
	assert.equal(second.scope, "mcp:read");
	// The earlier access token stops working with the refresh.
	assert.equal(await m.authenticateMcpRequest(env, bearer(first.access_token), RESOURCE), null);
	assert.ok(await m.authenticateMcpRequest(env, bearer(second.access_token), RESOURCE));
	await rejects(refresh(first.refresh_token), "invalid_grant");
	assert.equal(await m.authenticateMcpRequest(env, bearer(second.access_token), RESOURCE), null);
	await rejects(refresh(second.refresh_token), "invalid_grant");
});

test("an expired refresh token is refused, and a disabled user cannot refresh", async (t) => {
	const { env, database } = await fixture(t);
	let flow = await connect(env);
	let tokens = await exchange(env, flow.client, flow.code);
	const later = new Date(Date.now() + 31 * 24 * 60 * 60_000);
	await rejects(
		m.refreshTokens(env, { clientId: flow.client.id, refreshToken: tokens.refresh_token }, later),
		"invalid_grant",
	);
	flow = await connect(env);
	tokens = await exchange(env, flow.client, flow.code);
	database.db.prepare("UPDATE users SET disabled = 1 WHERE id = 'user-1'").run();
	await rejects(
		m.refreshTokens(env, { clientId: flow.client.id, refreshToken: tokens.refresh_token }, new Date()),
		"invalid_grant",
	);
	assert.equal(await m.authenticateMcpRequest(env, bearer(tokens.access_token), RESOURCE), null);
});

test("revocation: a refresh token ends the grant, an access token only itself, and only for its own client", async (t) => {
	const { env, database } = await fixture(t);
	const { client, code } = await connect(env);
	const tokens = await exchange(env, client, code);
	await m.revokeToken(env, tokens.refresh_token, "mcpc_someone_else");
	assert.ok(await m.authenticateMcpRequest(env, bearer(tokens.access_token), RESOURCE));
	await m.revokeToken(env, tokens.access_token, client.id);
	assert.equal(await m.authenticateMcpRequest(env, bearer(tokens.access_token), RESOURCE), null);
	const renewed = await m.refreshTokens(env, { clientId: client.id, refreshToken: tokens.refresh_token }, new Date());
	await m.revokeToken(env, renewed.refresh_token, client.id);
	assert.equal(database.db.prepare("SELECT count(*) AS n FROM api_keys WHERE kind = 'oauth'").get().n, 0);
	assert.equal(await m.authenticateMcpRequest(env, bearer(renewed.access_token), RESOURCE), null);
	await m.revokeToken(env, "kite_rt_unknown", client.id);
});

test("connecting the same client again replaces its earlier grant, and grants list what was approved", async (t) => {
	const { env } = await fixture(t);
	const client = await m.registerClient(env, { name: "Repeat", redirectUris: [REDIRECT] }, new Date());
	const approve = () =>
		m.createAuthorizationCode(
			env,
			{
				clientId: client.id,
				userId: "user-1",
				redirectUri: REDIRECT,
				codeChallenge: CHALLENGE,
				resource: RESOURCE,
				scopes: ["mcp:read"],
				mailboxIds: ["mailbox-1", "mailbox-2"],
			},
			new Date(),
		);
	const first = await exchange(env, client, await approve());
	const second = await exchange(env, client, await approve());
	assert.equal(await m.authenticateMcpRequest(env, bearer(first.access_token), RESOURCE), null);
	const principal = await m.authenticateMcpRequest(env, bearer(second.access_token), RESOURCE);
	// The other user's mailbox was never readable, so the grant leaves it out.
	assert.deepEqual(principal.mailboxIds, ["mailbox-1"]);
	const grants = await m.listGrants(env, "user-1");
	assert.equal(grants.length, 1);
	assert.equal(grants[0].clientName, "Repeat");
	assert.deepEqual(grants[0].scopes, ["mcp:read"]);
	assert.deepEqual(grants[0].mailboxIds, ["mailbox-1"]);
	assert.deepEqual(await m.listGrants(env, "user-2"), []);
});

/** One JSON-RPC call through the same MCP handler keys use. */
async function rpc(env, principal, method, params) {
	const handler = await m.createKiteMcpHandler(env, principal, ISSUER, "Bearer test");
	try {
		const response = await handler.fetch(
			new Request(RESOURCE, {
				method: "POST",
				headers: {
					Accept: "application/json, text/event-stream",
					"Content-Type": "application/json",
					"MCP-Protocol-Version": "2025-06-18",
				},
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
			}),
		);
		const body = await response.text();
		const data = body.startsWith("{")
			? body
			: body
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5))
					.join("");
		return JSON.parse(data);
	} finally {
		await handler.close();
	}
}

test("an OAuth grant gets the tools of its scopes only, like an MCP key", async (t) => {
	const { env } = await fixture(t);
	const { client, code } = await connect(env, { scopes: ["mcp:read"] });
	const tokens = await exchange(env, client, code);
	const principal = await m.authenticateMcpRequest(env, bearer(tokens.access_token), RESOURCE);
	const listed = await rpc(env, principal, "tools/list");
	const names = listed.result.tools.map((tool) => tool.name);
	assert.ok(names.includes("list_emails"));
	assert.ok(names.includes("list_mailboxes"));
	for (const name of ["draft_email", "move_email", "request_send", "manage_domains"])
		assert.equal(names.includes(name), false, name);
	const refused = await rpc(env, principal, "tools/call", {
		name: "draft_email",
		arguments: { mailboxId: "mailbox-1", to: "a@example.net", subject: "x", body: "y" },
	});
	assert.ok(refused.error || refused.result?.isError, JSON.stringify(refused));
});

test("pruning removes expired rows, grants without a live refresh token, orphan keys and unused registrations", async (t) => {
	const { env, database } = await fixture(t);
	const old = new Date(Date.now() - 2 * 24 * 60 * 60_000);
	await m.registerClient(env, { name: "Abandoned", redirectUris: [REDIRECT] }, old);
	const { client, code } = await connect(env);
	const tokens = await exchange(env, client, code);
	database.db.exec(
		"INSERT INTO api_keys (id, kind, user_id, name, prefix, key_hash, scopes, mailbox_scope_enabled, created_at) VALUES ('key_orphan', 'oauth', 'user-1', 'Restored', 'oauth', '!', '[\"mcp:read\"]', 1, 1)",
	);
	const result = await m.runDatabasePruning(env, new Date());
	assert.equal(result.mcp_oauth_grants, 0);
	const names = database.db
		.prepare("SELECT name FROM mcp_oauth_clients ORDER BY name")
		.all()
		.map((row) => row.name);
	assert.deepEqual(names, ["Test client"]);
	assert.equal(database.db.prepare("SELECT count(*) AS n FROM api_keys WHERE id = 'key_orphan'").get().n, 0);
	assert.ok(await m.authenticateMcpRequest(env, bearer(tokens.access_token), RESOURCE));
	// A refresh 20 days on keeps the registration in use; 31 days after that the refresh token has expired, so the
	// grant goes, and with it the registration, whose last use is more than 30 days ago.
	const refreshedAt = new Date(Date.now() + 20 * 24 * 60 * 60_000);
	await m.refreshTokens(env, { clientId: client.id, refreshToken: tokens.refresh_token }, refreshedAt);
	await m.pruneMcpOAuth(env, new Date(refreshedAt.getTime() + 15 * 24 * 60 * 60_000));
	assert.equal(database.db.prepare("SELECT count(*) AS n FROM api_keys WHERE kind = 'oauth'").get().n, 1);
	const later = new Date(refreshedAt.getTime() + 31 * 24 * 60 * 60_000);
	assert.equal(await m.pruneMcpOAuth(env, later), 1);
	assert.equal(database.db.prepare("SELECT count(*) AS n FROM api_keys WHERE kind = 'oauth'").get().n, 0);
	assert.equal(database.db.prepare("SELECT count(*) AS n FROM mcp_oauth_clients").get().n, 0);
});

test("registrations stop at the cap of unused clients", async (t) => {
	const { env, database } = await fixture(t);
	const insert = database.db.prepare(
		"INSERT INTO mcp_oauth_clients (id, name, redirect_uris, created_at) VALUES (?, 'x', '[]', 1)",
	);
	for (let index = 0; index < m.OAUTH_MAX_UNUSED_CLIENTS; index++) insert.run(`mcpc_${index}`);
	await assert.rejects(
		m.registerClient(env, { name: "One more", redirectUris: [REDIRECT] }, new Date()),
		(error) => error.code === "temporarily_unavailable" && error.status === 429,
	);
});

test("backups leave the OAuth tables out and still cover the database", async (t) => {
	const { env } = await fixture(t);
	const { client, code } = await connect(env);
	await exchange(env, client, code);
	await m.assertBackupTablesCoverDatabase(env.DB);
	const document = JSON.parse(new TextDecoder().decode(await m.exportDatabaseRecords(env.DB)));
	const tables = document.tables ?? document;
	assert.ok("api_keys" in tables);
	for (const table of ["mcp_oauth_clients", "mcp_oauth_codes", "mcp_oauth_grants", "mcp_oauth_tokens"])
		assert.equal(table in tables, false, table);
});

test("before migration 0106 reads fall back and writes report the pending migration", async (t) => {
	const { env } = await fixture(t, copyMigrationsBefore(scratch, 106));
	assert.equal(await m.authenticateMcpRequest(env, bearer("kite_at_whatever"), RESOURCE), null);
	assert.equal(await m.pruneMcpOAuth(env, new Date()), 0);
	const result = await m.runDatabasePruning(env, new Date());
	assert.equal(result.mcp_oauth_grants, 0);
	await assert.rejects(m.registerClient(env, { name: "Early", redirectUris: [REDIRECT] }, new Date()), (error) =>
		/no such table/i.test(error.message),
	);
});
