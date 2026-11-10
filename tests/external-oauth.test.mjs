import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

// Sign in with Microsoft (spec §15), the pure parts: the XOAUTH2 initial response, PKCE and the state, the authorize
// URL and token requests, the token endpoint's answers and errors, the ID token's address, when to refresh, the
// owner's app registration, and the page's messages after the callback.

const {
	xoauth2Token,
	pkceChallenge,
	randomUrlToken,
	hashOAuthState,
	parseCallbackState,
	microsoftAuthorizeUrl,
	microsoftEndpoints,
	tokenRequestBody,
	parseTokenResponse,
	tokenFailure,
	OAuthTokenError,
	idTokenClaims,
	needsRefresh,
	ACCESS_TOKEN_MARGIN_MS,
	parseMicrosoftClientInput,
	parseStoredMicrosoftClient,
	clientCheckVerdict,
	oauthTestOrigin,
	oauthRedirectUri,
	grantsImap,
	isTenant,
	MICROSOFT_SCOPES,
	oauthResultMessage,
	oauthResultPath,
	classifyConnectionError,
	parseImapImportRequest,
	parseImapFolderListRequest,
} = await bundleModules("kite-external-oauth-", [
	["xoauth2Token", "src/lib/net/xoauth2-utils.ts"],
	[
		"pkceChallenge, randomUrlToken, hashOAuthState, parseCallbackState, microsoftAuthorizeUrl, microsoftEndpoints, tokenRequestBody, parseTokenResponse, tokenFailure, OAuthTokenError, idTokenClaims, needsRefresh, ACCESS_TOKEN_MARGIN_MS, parseMicrosoftClientInput, parseStoredMicrosoftClient, clientCheckVerdict, oauthTestOrigin, oauthRedirectUri, grantsImap, isTenant, MICROSOFT_SCOPES",
		"src/lib/external-accounts/oauth-utils.ts",
	],
	["oauthResultMessage, oauthResultPath", "src/lib/external-accounts/oauth-result-utils.ts"],
	["classifyConnectionError", "src/lib/external-accounts/connection-utils.ts"],
	["parseImapImportRequest", "src/app/api/import/imap/utils.ts"],
	["parseImapFolderListRequest", "src/app/api/import/imap/folders/utils.ts"],
]);

const CLIENT_ID = "11111111-2222-3333-4444-555555555555";
const jwt = (claims) =>
	`${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.`;

test("the XOAUTH2 initial response is base64 of user=…^Aauth=Bearer …^A^A and refuses control characters", () => {
	const token = xoauth2Token("someone@outlook.com", "EwBg.token-value");
	assert.equal(
		Buffer.from(token, "base64").toString("utf8"),
		"user=someone@outlook.com\x01auth=Bearer EwBg.token-value\x01\x01",
	);
	// The example from Google's XOAUTH2 documentation.
	assert.equal(
		xoauth2Token("someuser@example.com", "ya29.vF9dft4qmTc2Nvb3RlckBhdHRhdmlzdGEuY29tCg"),
		"dXNlcj1zb21ldXNlckBleGFtcGxlLmNvbQFhdXRoPUJlYXJlciB5YTI5LnZGOWRmdDRxbVRjMk52YjNSbGNrQmhkSFJoZG1semRHRXVZMjl0Q2cBAQ==",
	);
	assert.match(
		Buffer.from(xoauth2Token("rené@exämple.com", "t"), "base64").toString("utf8"),
		/^user=rené@exämple\.com\x01/,
	);
	for (const [user, accessToken] of [
		["a@b.c\x01auth=Bearer evil", "secret-token"],
		["a@b.c", "secret-token\x01"],
		["a@b.c\r\n", "secret-token"],
		["a@b.c", "secret token"],
		["", "secret-token"],
		["a@b.c", ""],
	])
		assert.throws(
			() => xoauth2Token(user, accessToken),
			(error) => /XOAUTH2/.test(error.message) && !error.message.includes("secret"),
		);
});

test("PKCE: a 43-character verifier and its S256 challenge, as RFC 7636 computes it", async () => {
	const verifier = randomUrlToken();
	assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
	assert.notEqual(randomUrlToken(), verifier);
	assert.equal(await pkceChallenge(verifier), createHash("sha256").update(verifier).digest("base64url"));
	// RFC 7636 Appendix B.
	assert.equal(
		await pkceChallenge("dBjftJeZ4CVP-mJ92UWQ1oEZD6-8NNrwF9aCs9TGjJQ"),
		createHash("sha256").update("dBjftJeZ4CVP-mJ92UWQ1oEZD6-8NNrwF9aCs9TGjJQ").digest("base64url"),
	);
	await assert.rejects(pkceChallenge("short"));
	await assert.rejects(pkceChallenge(`${"a".repeat(42)} `));
});

test("states are stored only as their SHA-256, and the callback accepts only the shape Kite makes", async () => {
	const state = randomUrlToken();
	const hash = await hashOAuthState(state);
	assert.match(hash, /^[0-9a-f]{64}$/);
	assert.equal(hash, createHash("sha256").update(state).digest("hex"));
	assert.notEqual(hash, state);
	assert.equal(parseCallbackState(state), state);
	for (const value of [null, "", "short", `${state}x`, `${state.slice(0, 42)}=`, "a".repeat(43).replace("a", "/")])
		assert.equal(parseCallbackState(value), null);
});

test("the authorize URL asks for IMAP, SMTP, offline access and the address, with PKCE and the state", () => {
	const endpoints = microsoftEndpoints("common");
	assert.deepEqual(endpoints, {
		authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
		token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
	});
	const url = new URL(
		microsoftAuthorizeUrl({
			endpoints,
			clientId: CLIENT_ID,
			redirectUri: "https://mail.example.com/api/external-accounts/oauth/callback",
			state: "S".repeat(43),
			challenge: "C".repeat(43),
			loginHint: "someone@outlook.com",
		}),
	);
	assert.equal(url.searchParams.get("response_type"), "code");
	assert.equal(url.searchParams.get("code_challenge_method"), "S256");
	assert.equal(url.searchParams.get("login_hint"), "someone@outlook.com");
	assert.deepEqual(url.searchParams.get("scope").split(" "), [
		"https://outlook.office.com/IMAP.AccessAsUser.All",
		"https://outlook.office.com/SMTP.Send",
		"offline_access",
		"openid",
		"email",
	]);
	assert.deepEqual([...MICROSOFT_SCOPES], url.searchParams.get("scope").split(" "));
	// A tenant can never steer the request to another host or path.
	assert.throws(() => microsoftEndpoints("evil.com/x"));
	assert.throws(() => microsoftEndpoints("../common"));
	assert.equal(
		microsoftEndpoints("contoso.onmicrosoft.com", "http://127.0.0.1:9").token,
		"http://127.0.0.1:9/contoso.onmicrosoft.com/oauth2/v2.0/token",
	);
});

test("token requests: the code with its verifier, or a refresh asking for the Outlook scopes again", () => {
	const client = { clientId: CLIENT_ID, clientSecret: "s3cret" };
	const code = tokenRequestBody(client, { kind: "authorization_code", code: "c", verifier: "v", redirectUri: "r" });
	assert.equal(code.get("grant_type"), "authorization_code");
	assert.equal(code.get("code_verifier"), "v");
	assert.equal(code.get("redirect_uri"), "r");
	const refresh = tokenRequestBody(client, { kind: "refresh_token", refreshToken: "rt" });
	assert.equal(refresh.get("grant_type"), "refresh_token");
	assert.equal(refresh.get("refresh_token"), "rt");
	assert.ok(!refresh.get("scope").includes("openid"));
	assert.ok(refresh.get("scope").includes("offline_access"));
});

test("token answers: the expiry is dated from now, and failures say what to do without a token in them", () => {
	const now = new Date("2026-11-09T10:00:00Z");
	const tokens = parseTokenResponse(
		{ token_type: "Bearer", access_token: "at", refresh_token: "rt", expires_in: 3599, scope: "a b", id_token: "x.y." },
		now,
	);
	assert.equal(tokens.expiresAt.toISOString(), "2026-11-09T10:59:59.000Z");
	assert.equal(tokens.refreshToken, "rt");
	assert.equal(parseTokenResponse({ access_token: "at" }, now).refreshToken, null);
	assert.equal(
		parseTokenResponse({ access_token: "at", expires_in: "nonsense" }, now).expiresAt.getTime() - now.getTime(),
		3_600_000,
	);
	assert.throws(() => parseTokenResponse({}, now), OAuthTokenError);
	assert.throws(() => parseTokenResponse({ access_token: "a b" }, now), OAuthTokenError);
	assert.throws(() => parseTokenResponse({ access_token: "at", token_type: "mac" }, now), OAuthTokenError);

	const revoked = tokenFailure(400, {
		error: "invalid_grant",
		error_description: "AADSTS70008: The refresh token has expired due to inactivity. Trace ID: secret-trace",
	});
	assert.equal(revoked.kind, "reauth");
	assert.equal(revoked.code, "AADSTS70008");
	assert.match(revoked.message, /Reconnect the account \(invalid_grant, AADSTS70008\)/);
	assert.ok(!revoked.message.includes("secret-trace"));
	assert.equal(
		tokenFailure(401, { error: "invalid_client", error_description: "AADSTS7000222: expired" }).kind,
		"client",
	);
	assert.equal(tokenFailure(503, null).kind, "transient");
	assert.equal(tokenFailure(429, {}).kind, "transient");
	assert.equal(tokenFailure(400, { error: "temporarily_unavailable" }).kind, "transient");
	assert.equal(tokenFailure(400, { error: "interaction_required" }).kind, "reauth");
});

const WORK_TID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CONSUMER_TID = "9188040d-6c67-4c5b-b112-36a304b66dad";
const idToken = (claims, tid = WORK_TID) =>
	jwt({ aud: CLIENT_ID, iss: `https://login.microsoftonline.com/${tid}/v2.0`, tid, oid: "o1", ...claims });

test("the ID token names the address the user signed in as, the tenant and the user, for this app only", () => {
	assert.deepEqual(
		idTokenClaims(idToken({ preferred_username: "Someone@Outlook.com", sub: "s1" }, CONSUMER_TID), CLIENT_ID),
		{
			address: "someone@outlook.com",
			subject: `${CONSUMER_TID}:o1`,
			tenantId: CONSUMER_TID,
		},
	);
	// The sign-in name wins over an `email` claim, which an organisation can set to anything.
	assert.equal(
		idTokenClaims(idToken({ email: "ceo@victim.example", preferred_username: "b@contoso.com" }), CLIENT_ID).address,
		"b@contoso.com",
	);
	// `email` counts only when Microsoft marks its domain verified, and only without a sign-in name.
	assert.equal(idTokenClaims(idToken({ email: "a@contoso.com" }), CLIENT_ID), null);
	assert.equal(idTokenClaims(idToken({ email: "a@contoso.com", xms_edov: true }), CLIENT_ID).address, "a@contoso.com");
	assert.equal(
		idTokenClaims(
			jwt({
				aud: CLIENT_ID.toUpperCase(),
				iss: `https://login.microsoftonline.com/${WORK_TID}/v2.0`,
				tid: WORK_TID,
				preferred_username: "x@contoso.com",
				sub: "s1",
			}),
			CLIENT_ID,
		).subject,
		`${WORK_TID}:s1`,
	);
	// Another app's token, a missing or mismatched tenant and issuer, no address or subject, and garbage are refused.
	assert.equal(idTokenClaims(idToken({ aud: "other", preferred_username: "a@b.com" }), CLIENT_ID), null);
	assert.equal(idTokenClaims(idToken({ preferred_username: "not-an-address" }), CLIENT_ID), null);
	assert.equal(idTokenClaims(idToken({ preferred_username: "a@b.com", oid: undefined }), CLIENT_ID), null);
	assert.equal(idTokenClaims(idToken({ preferred_username: "a@b.com", tid: undefined }), CLIENT_ID), null);
	assert.equal(idTokenClaims(idToken({ preferred_username: "a@b.com", tid: "not-a-tenant" }), CLIENT_ID), null);
	assert.equal(
		idTokenClaims(
			idToken({ preferred_username: "a@b.com", iss: "https://login.microsoftonline.com/common/v2.0" }),
			CLIENT_ID,
		),
		null,
	);
	assert.equal(
		idTokenClaims(idToken({ preferred_username: "a@b.com", iss: `https://evil.example/${WORK_TID}/v2.0` }), CLIENT_ID),
		null,
	);
	assert.equal(idTokenClaims("not.a.jwt", CLIENT_ID), null);
	assert.equal(idTokenClaims(null, CLIENT_ID), null);
});

test("the ID token's tenant must fit the registration's tenant", () => {
	const work = idToken({ preferred_username: "a@contoso.com" });
	const personal = idToken({ preferred_username: "a@outlook.com" }, CONSUMER_TID);
	assert.ok(idTokenClaims(work, CLIENT_ID, WORK_TID));
	assert.equal(idTokenClaims(work, CLIENT_ID, "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee"), null);
	assert.equal(idTokenClaims(personal, CLIENT_ID, WORK_TID), null);
	assert.ok(idTokenClaims(personal, CLIENT_ID, "consumers"));
	assert.equal(idTokenClaims(work, CLIENT_ID, "consumers"), null);
	assert.ok(idTokenClaims(work, CLIENT_ID, "organizations"));
	assert.equal(idTokenClaims(personal, CLIENT_ID, "organizations"), null);
	assert.ok(idTokenClaims(work, CLIENT_ID, "common") && idTokenClaims(personal, CLIENT_ID, "common"));
});

test("a cached access token is used until five minutes before it expires", () => {
	const now = new Date("2026-11-09T10:00:00Z");
	const at = (ms) => new Date(now.getTime() + ms);
	assert.equal(ACCESS_TOKEN_MARGIN_MS, 5 * 60_000);
	assert.equal(needsRefresh(at(60 * 60_000), now, true), false);
	assert.equal(needsRefresh(at(5 * 60_000 + 1), now, true), false);
	assert.equal(needsRefresh(at(5 * 60_000), now, true), true);
	assert.equal(needsRefresh(at(-1), now, true), true);
	assert.equal(needsRefresh(null, now, true), true);
	assert.equal(needsRefresh(at(60 * 60_000), now, false), true);
});

test("the owner's app registration: a GUID client ID, the secret's value, and a tenant that is a name, an id or a domain", () => {
	const ok = parseMicrosoftClientInput({ clientId: ` ${CLIENT_ID.toUpperCase()} `, clientSecret: " abc~DEF.123 " });
	assert.deepEqual(ok, { ok: true, client: { clientId: CLIENT_ID, clientSecret: "abc~DEF.123", tenant: "common" } });
	for (const tenant of [
		"organizations",
		"consumers",
		"contoso.onmicrosoft.com",
		"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
	])
		assert.equal(parseMicrosoftClientInput({ clientId: CLIENT_ID, clientSecret: "x", tenant }).ok, true);
	assert.equal(parseMicrosoftClientInput({ clientId: "not-a-guid", clientSecret: "x" }).ok, false);
	assert.equal(parseMicrosoftClientInput({ clientId: CLIENT_ID, clientSecret: "" }).ok, false);
	assert.equal(parseMicrosoftClientInput({ clientId: CLIENT_ID, clientSecret: "has space" }).ok, false);
	assert.equal(parseMicrosoftClientInput({ clientId: CLIENT_ID, clientSecret: "x", tenant: "a/b" }).ok, false);
	assert.equal(parseMicrosoftClientInput(null).ok, false);
	assert.equal(isTenant("common"), true);
	assert.equal(isTenant("localhost"), false);
	assert.deepEqual(parseStoredMicrosoftClient(JSON.stringify(ok.client)), ok.client);
	assert.equal(parseStoredMicrosoftClient("{"), null);
	assert.equal(parseStoredMicrosoftClient(null), null);
});

test("checking a registration: a refused secret or unknown app is rejected, a refused made-up code is fine", () => {
	assert.deepEqual(
		clientCheckVerdict(400, { error: "invalid_grant", error_description: "AADSTS9002313: Invalid request." }),
		{
			verdict: "ok",
		},
	);
	assert.equal(
		clientCheckVerdict(401, {
			error: "invalid_client",
			error_description: "AADSTS7000215: Invalid client secret provided.",
		}).verdict,
		"rejected",
	);
	assert.match(
		clientCheckVerdict(401, {
			error: "invalid_client",
			error_description: "AADSTS7000222: The provided client secret keys are expired.",
		}).error,
		/AADSTS7000222/,
	);
	assert.match(
		clientCheckVerdict(400, { error: "unauthorized_client", error_description: "AADSTS700016: not found" }).error,
		/AADSTS700016/,
	);
	assert.equal(
		clientCheckVerdict(400, { error: "invalid_request", error_description: "AADSTS90002: Tenant not found." }).verdict,
		"rejected",
	);
	assert.deepEqual(clientCheckVerdict(503, null), { verdict: "unverified" });
});

test("the test origin is loopback http outside production only, and the redirect URI sits under APP_URL", () => {
	assert.equal(oauthTestOrigin("http://127.0.0.1:4100", "development"), "http://127.0.0.1:4100");
	assert.equal(oauthTestOrigin("http://127.0.0.1:4100", "production"), null);
	assert.equal(oauthTestOrigin("https://127.0.0.1:4100", "development"), null);
	assert.equal(oauthTestOrigin("http://login.example.com", "development"), null);
	assert.equal(oauthTestOrigin(undefined, "development"), null);
	assert.equal(
		oauthRedirectUri("https://mail.example.com/", "http://10.0.0.5:3000"),
		"https://mail.example.com/api/external-accounts/oauth/callback",
	);
	assert.equal(
		oauthRedirectUri(undefined, "http://localhost:3000/settings"),
		"http://localhost:3000/api/external-accounts/oauth/callback",
	);
	assert.equal(
		oauthRedirectUri("not a url", "http://localhost:3000"),
		"http://localhost:3000/api/external-accounts/oauth/callback",
	);
});

test("granted scopes: IMAP is required", () => {
	assert.equal(grantsImap("https://outlook.office.com/IMAP.AccessAsUser.All openid"), true);
	assert.equal(grantsImap("IMAP.AccessAsUser.All"), true);
	assert.equal(grantsImap("https://outlook.office.com/SMTP.Send"), false);
});

test("the callback's outcome travels as codes only, and the page turns them into words", () => {
	const connected = oauthResultPath({ ok: true, accountId: "xacct_1", reconnected: false });
	assert.equal(connected, "/settings/connected-accounts?oauth=connected&account=xacct_1");
	const message = oauthResultMessage(new URL(connected, "http://k").searchParams);
	assert.deepEqual(message, { tone: "success", text: "Microsoft account connected.", accountId: "xacct_1" });
	const failed = oauthResultMessage(
		new URL(oauthResultPath({ ok: false, reason: "admin_consent" }), "http://k").searchParams,
	);
	assert.equal(failed.tone, "error");
	assert.match(failed.text, /administrator/);
	// A made-up reason never puts its own text on the page.
	const unknown = oauthResultMessage(new URLSearchParams("oauth=failed&reason=<script>"));
	assert.equal(unknown.text, "Something went wrong connecting the Microsoft account. Try again.");
	assert.equal(oauthResultMessage(new URLSearchParams("")), null);
});

test("a refused OAuth sign-in says to reconnect, and the token never reaches the text", () => {
	const problem = classifyConnectionError(new Error("IMAP sign-in failed: NO AUTHENTICATE failed. at-secret"), {
		refused: false,
		secrets: ["at-secret"],
		oauth: true,
	});
	assert.equal(problem.kind, "auth");
	assert.match(problem.message, /Reconnect to sign in with Microsoft again/);
	assert.ok(!problem.message.includes("at-secret"));
});

test("an import request never brings its own access token: only core's login for a connected account does", () => {
	const request = {
		mailboxId: "m",
		host: "imap.example.test",
		username: "a@b.test",
		password: "",
		accessToken: "client",
	};
	assert.throws(() => parseImapImportRequest(request), /username and password are required/);
	assert.throws(() => parseImapFolderListRequest(request), /username and password are required/);
	const withPassword = parseImapFolderListRequest({ ...request, password: "pw" });
	assert.equal(withPassword.accessToken, undefined);
	assert.equal(parseImapImportRequest(request, "from-core").accessToken, "from-core");
	assert.equal(parseImapFolderListRequest(request, "from-core").accessToken, "from-core");
});
