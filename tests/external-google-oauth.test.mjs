import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

// Sign in with Google (spec §15.7), the pure parts: the authorize URL with offline access, consent and PKCE, the token
// requests, the ID token's checks (issuer, audience, expiry, verified address, Workspace domain), the owner's OAuth
// client and Google's answer to a made-up code, the wording of failures, and how the connect dialog picks the sign-in.

const {
	xoauth2Token,
	pkceChallenge,
	randomUrlToken,
	parseCallbackState,
	tokenFailure,
	parseTokenResponse,
	OAuthTokenError,
	GOOGLE_SCOPES,
	googleEndpoints,
	googleAuthorizeUrl,
	googleTokenRequestBody,
	grantsGmail,
	googleIdTokenClaims,
	googleAuthorizeFailure,
	googleClientCheckVerdict,
	parseGoogleClientInput,
	parseStoredGoogleClient,
	oauthAccountPreset,
	oauthProviderOf,
	isOAuthProvider,
	oauthResultMessage,
	oauthResultPath,
	classifyConnectionError,
	oauthSignInFor,
	submitLabel,
	statusHint,
} = await bundleModules("kite-external-google-oauth-", [
	["xoauth2Token", "src/lib/net/xoauth2-utils.ts"],
	[
		"pkceChallenge, randomUrlToken, parseCallbackState, tokenFailure, parseTokenResponse, OAuthTokenError",
		"src/lib/external-accounts/oauth-utils.ts",
	],
	[
		"GOOGLE_SCOPES, googleEndpoints, googleAuthorizeUrl, googleTokenRequestBody, grantsGmail, googleIdTokenClaims, googleAuthorizeFailure, googleClientCheckVerdict, parseGoogleClientInput, parseStoredGoogleClient",
		"src/lib/external-accounts/oauth-google-utils.ts",
	],
	["oauthAccountPreset, oauthProviderOf, isOAuthProvider", "src/lib/external-accounts/oauth-provider-utils.ts"],
	["oauthResultMessage, oauthResultPath", "src/lib/external-accounts/oauth-result-utils.ts"],
	["classifyConnectionError", "src/lib/external-accounts/connection-utils.ts"],
	["oauthSignInFor, submitLabel, statusHint", "src/components/settings/connected-accounts/connected-accounts-utils.ts"],
]);

const CLIENT_ID = "123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com";
const CLIENT = { clientId: CLIENT_ID, clientSecret: "GOCSPX-secret", hostedDomain: null };
const NOW = new Date("2026-11-10T12:00:00Z");
const seconds = (date) => Math.floor(date.getTime() / 1000);
const jwt = (claims) =>
	`${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const claims = (extra = {}) => ({
	iss: "https://accounts.google.com",
	azp: CLIENT_ID,
	aud: CLIENT_ID,
	sub: "110169484474386276334",
	email: "Someone@Gmail.com",
	email_verified: true,
	iat: seconds(NOW) - 10,
	exp: seconds(NOW) + 3590,
	...extra,
});

test("the XOAUTH2 string for a Gmail account is Google's documented form", () => {
	assert.equal(
		Buffer.from(
			xoauth2Token("someone@gmail.com", "ya29.vF9dft4qmTc2Nvb3RlckBhdHRhdmlzdGEuY29tCg"),
			"base64",
		).toString(),
		"user=someone@gmail.com\x01auth=Bearer ya29.vF9dft4qmTc2Nvb3RlckBhdHRhdmlzdGEuY29tCg\x01\x01",
	);
});

test("the authorize URL asks for Gmail offline with consent, PKCE S256, the state and the hints", async () => {
	const verifier = randomUrlToken();
	const state = randomUrlToken();
	const challenge = await pkceChallenge(verifier);
	assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));
	const url = new URL(
		googleAuthorizeUrl({
			endpoints: googleEndpoints(),
			clientId: CLIENT_ID,
			redirectUri: "https://mail.example.com/api/external-accounts/oauth/callback",
			state,
			challenge,
			loginHint: "someone@gmail.com",
			hostedDomain: "example.com",
		}),
	);
	assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
	const params = Object.fromEntries(url.searchParams);
	assert.deepEqual(params, {
		client_id: CLIENT_ID,
		response_type: "code",
		redirect_uri: "https://mail.example.com/api/external-accounts/oauth/callback",
		scope: "https://mail.google.com/ openid email",
		state,
		code_challenge: challenge,
		code_challenge_method: "S256",
		access_type: "offline",
		prompt: "consent",
		login_hint: "someone@gmail.com",
		hd: "example.com",
	});
	assert.deepEqual([...GOOGLE_SCOPES], ["https://mail.google.com/", "openid", "email"]);
	// The callback takes back exactly the state it sent.
	assert.equal(parseCallbackState(state), state);
	// No hints, no hint parameters; the test origin only replaces the host, under /google.
	const bare = new URL(
		googleAuthorizeUrl({
			endpoints: googleEndpoints("http://127.0.0.1:9"),
			clientId: CLIENT_ID,
			redirectUri: "http://localhost/cb",
			state,
			challenge,
		}),
	);
	assert.equal(bare.origin + bare.pathname, "http://127.0.0.1:9/google/o/oauth2/v2/auth");
	assert.equal(bare.searchParams.has("login_hint"), false);
	assert.equal(bare.searchParams.has("hd"), false);
	assert.deepEqual(googleEndpoints(), {
		authorize: "https://accounts.google.com/o/oauth2/v2/auth",
		token: "https://oauth2.googleapis.com/token",
	});
	assert.equal(googleEndpoints("http://127.0.0.1:9").token, "http://127.0.0.1:9/google/token");
});

test("token requests carry the client, the code with its verifier, or the refresh token (no scope)", () => {
	const code = Object.fromEntries(
		googleTokenRequestBody(CLIENT, {
			kind: "authorization_code",
			code: "4/abc",
			verifier: "v".repeat(43),
			redirectUri: "https://k/cb",
		}),
	);
	assert.deepEqual(code, {
		client_id: CLIENT_ID,
		client_secret: "GOCSPX-secret",
		grant_type: "authorization_code",
		code: "4/abc",
		code_verifier: "v".repeat(43),
		redirect_uri: "https://k/cb",
	});
	const refresh = Object.fromEntries(googleTokenRequestBody(CLIENT, { kind: "refresh_token", refreshToken: "1//rt" }));
	assert.deepEqual(refresh, {
		client_id: CLIENT_ID,
		client_secret: "GOCSPX-secret",
		grant_type: "refresh_token",
		refresh_token: "1//rt",
	});
});

test("Gmail access must be granted: Google lets the user untick it", () => {
	assert.equal(grantsGmail("https://mail.google.com/ openid https://www.googleapis.com/auth/userinfo.email"), true);
	assert.equal(grantsGmail("openid https://www.googleapis.com/auth/userinfo.email"), false);
	assert.equal(grantsGmail("https://mail.google.com/extra"), false);
	assert.equal(grantsGmail(""), false);
});

test("the ID token names the user only when it is Google's, for this client, current and verified", () => {
	const ok = googleIdTokenClaims(jwt(claims()), CLIENT, NOW);
	assert.deepEqual(ok, { ok: true, identity: { address: "someone@gmail.com", subject: "110169484474386276334" } });
	// Both documented issuer forms are Google's.
	assert.equal(googleIdTokenClaims(jwt(claims({ iss: "accounts.google.com" })), CLIENT, NOW).ok, true);
	const refused = (extra) => googleIdTokenClaims(jwt(claims(extra)), CLIENT, NOW);
	for (const iss of ["https://accounts.google.com.evil.test", "https://login.microsoftonline.com/x/v2.0", "", 1])
		assert.deepEqual(refused({ iss }), { ok: false, reason: "no_address" }, `iss ${iss}`);
	assert.deepEqual(refused({ iss: undefined }), { ok: false, reason: "no_address" });
	// Another client's token, or one whose authorized party is another client.
	assert.deepEqual(refused({ aud: "999-other.apps.googleusercontent.com" }), { ok: false, reason: "no_address" });
	assert.deepEqual(refused({ azp: "999-other.apps.googleusercontent.com" }), { ok: false, reason: "no_address" });
	assert.equal(refused({ aud: [CLIENT_ID, "other"] }).ok, true);
	assert.deepEqual(refused({ aud: ["other"] }), { ok: false, reason: "no_address" });
	// An address Google has not verified is not an address Kite connects.
	for (const email_verified of [false, "false", undefined, 1])
		assert.deepEqual(refused({ email_verified }), { ok: false, reason: "no_address" }, `verified ${email_verified}`);
	assert.equal(refused({ email_verified: "true" }).ok, true);
	assert.deepEqual(refused({ email: "not an address" }), { ok: false, reason: "no_address" });
	assert.deepEqual(refused({ sub: "" }), { ok: false, reason: "no_address" });
	assert.deepEqual(refused({ sub: 12345 }), { ok: false, reason: "no_address" });
	// Expired (beyond five minutes of clock skew), or without an expiry.
	assert.deepEqual(refused({ exp: seconds(NOW) - 600 }), { ok: false, reason: "no_address" });
	assert.equal(refused({ exp: seconds(NOW) - 60 }).ok, true);
	assert.deepEqual(refused({ exp: undefined }), { ok: false, reason: "no_address" });
	// Not a JWT at all.
	assert.deepEqual(googleIdTokenClaims(null, CLIENT, NOW), { ok: false, reason: "no_address" });
	assert.deepEqual(googleIdTokenClaims("garbage", CLIENT, NOW), { ok: false, reason: "no_address" });
});

test("a Workspace domain restriction needs the token's hd to match", () => {
	const restricted = { ...CLIENT, hostedDomain: "example.com" };
	const at = (extra) => googleIdTokenClaims(jwt(claims({ email: "ann@example.com", ...extra })), restricted, NOW);
	assert.deepEqual(at({ hd: "example.com" }), {
		ok: true,
		identity: { address: "ann@example.com", subject: "110169484474386276334" },
	});
	assert.equal(at({ hd: "Example.COM" }).ok, true);
	// A Gmail account carries no hd; another organisation's carries its own.
	assert.deepEqual(at({}), { ok: false, reason: "wrong_domain" });
	assert.deepEqual(at({ hd: "other.example" }), { ok: false, reason: "wrong_domain" });
	// The address's domain alone is not the proof: hd is.
	assert.deepEqual(at({ email: "ann@example.com", hd: undefined }), { ok: false, reason: "wrong_domain" });
	// Without a restriction, hd is not needed.
	assert.equal(googleIdTokenClaims(jwt(claims({ hd: "other.example" })), CLIENT, NOW).ok, true);
});

test("Google's redirect errors read as cancelled, blocked by the organisation, or refused", () => {
	assert.equal(googleAuthorizeFailure("access_denied"), "cancelled");
	assert.equal(googleAuthorizeFailure("admin_policy_enforced"), "admin_consent");
	assert.equal(googleAuthorizeFailure("org_internal"), "admin_consent");
	assert.equal(googleAuthorizeFailure("invalid_request"), "denied");
});

test("token failures from Google are sorted like Microsoft's and name Google", () => {
	const revoked = tokenFailure(
		400,
		{ error: "invalid_grant", error_description: "Token has been expired or revoked." },
		"Google",
	);
	assert.ok(revoked instanceof OAuthTokenError);
	assert.equal(revoked.kind, "reauth");
	assert.equal(revoked.message, "Google sign-in expired or was revoked. Reconnect the account (invalid_grant).");
	assert.ok(!revoked.message.includes("Token has been"), "Google's own description is never repeated");
	const client = tokenFailure(401, { error: "invalid_client", error_description: "Unauthorized" }, "Google");
	assert.equal(client.kind, "client");
	assert.match(client.message, /^Google refused this Kite's app registration\. Ask your admin to check Google sign-in/);
	assert.equal(tokenFailure(503, null, "Google").kind, "transient");
	assert.match(tokenFailure(503, null, "Google").message, /^Google could not be reached/);
	// Microsoft's wording is unchanged when no provider is named.
	assert.match(tokenFailure(400, { error: "invalid_grant" }).message, /^Microsoft sign-in expired/);
	// Google answers a refresh without a refresh token: the stored one is kept.
	const refreshed = parseTokenResponse(
		{ access_token: "ya29.a", expires_in: 3599, token_type: "Bearer" },
		NOW,
		"Google",
	);
	assert.equal(refreshed.refreshToken, null);
	assert.throws(() => parseTokenResponse({}, NOW, "Google"), /Google answered without a usable access token/);
});

test("the owner's OAuth client is checked for shape: a Google client ID, a secret, an optional domain", () => {
	assert.deepEqual(parseGoogleClientInput({ clientId: ` ${CLIENT_ID.toUpperCase()} `, clientSecret: " GOCSPX-x " }), {
		ok: true,
		client: { clientId: CLIENT_ID, clientSecret: "GOCSPX-x", hostedDomain: null },
	});
	assert.deepEqual(
		parseGoogleClientInput({ clientId: CLIENT_ID, clientSecret: "s", hostedDomain: " Example.COM " }).client,
		{ clientId: CLIENT_ID, clientSecret: "s", hostedDomain: "example.com" },
	);
	for (const clientId of ["", "abc", "123-abc.apps.googleusercontent.com.evil", "11111111-2222-3333-4444-555555555555"])
		assert.equal(parseGoogleClientInput({ clientId, clientSecret: "s" }).ok, false, clientId);
	for (const clientSecret of ["", "has space", "a\nb", "x".repeat(513), 5])
		assert.equal(parseGoogleClientInput({ clientId: CLIENT_ID, clientSecret }).ok, false);
	for (const hostedDomain of ["example", "http://example.com", "exa mple.com", "*.example.com"])
		assert.equal(parseGoogleClientInput({ clientId: CLIENT_ID, clientSecret: "s", hostedDomain }).ok, false);
	assert.equal(parseGoogleClientInput(null).ok, false);
	assert.deepEqual(parseStoredGoogleClient(JSON.stringify({ clientId: CLIENT_ID, clientSecret: "s" })), {
		clientId: CLIENT_ID,
		clientSecret: "s",
		hostedDomain: null,
	});
	assert.equal(parseStoredGoogleClient("{not json"), null);
	assert.equal(parseStoredGoogleClient(null), null);
	assert.equal(parseStoredGoogleClient(JSON.stringify({ clientId: "x" })), null);
});

test("Google's answer to a made-up code says whether the client ID and secret are right", () => {
	assert.match(
		googleClientCheckVerdict(401, { error: "invalid_client", error_description: "The OAuth client was not found." })
			.error,
		/knows no OAuth client/,
	);
	assert.match(
		googleClientCheckVerdict(401, { error: "invalid_client", error_description: "Unauthorized" }).error,
		/refused the client secret/,
	);
	assert.equal(googleClientCheckVerdict(400, { error: "unauthorized_client" }).verdict, "rejected");
	assert.deepEqual(
		googleClientCheckVerdict(400, { error: "invalid_grant", error_description: "Malformed auth code." }),
		{
			verdict: "ok",
		},
	);
	assert.deepEqual(googleClientCheckVerdict(503, null), { verdict: "unverified" });
	assert.deepEqual(googleClientCheckVerdict(429, {}), { verdict: "unverified" });
});

test("providers: the account's preset follows its address, the sign-in kind names the provider", () => {
	assert.equal(oauthAccountPreset("google", "a@gmail.com"), "gmail");
	assert.equal(oauthAccountPreset("google", "a@googlemail.com"), "gmail");
	assert.equal(oauthAccountPreset("google", "a@example.com"), "google_workspace");
	assert.equal(oauthAccountPreset("microsoft", "a@example.com"), "microsoft");
	assert.equal(oauthProviderOf("oauth_google"), "google");
	assert.equal(oauthProviderOf("oauth_microsoft"), "microsoft");
	assert.equal(oauthProviderOf("password"), null);
	assert.equal(isOAuthProvider("google"), true);
	assert.equal(isOAuthProvider("github"), false);
});

test("the page after a Google sign-in names Google, and every failure has its own words", () => {
	const connected = oauthResultPath({ ok: true, provider: "google", accountId: "xacct_2", reconnected: false });
	assert.equal(connected, "/settings/connected-accounts?oauth=connected&account=xacct_2&provider=google");
	assert.deepEqual(oauthResultMessage(new URL(connected, "http://k").searchParams), {
		tone: "success",
		text: "Google account connected.",
		accountId: "xacct_2",
	});
	const text = (reason) =>
		oauthResultMessage(new URL(oauthResultPath({ ok: false, reason, provider: "google" }), "http://k").searchParams)
			.text;
	assert.equal(text("cancelled"), "The Google sign-in was cancelled. Nothing was connected.");
	assert.match(text("wrong_domain"), /Workspace domain your admin chose/);
	assert.match(text("scopes"), /did not grant access to Gmail/);
	assert.match(text("imap_refused"), /Gmail refused Kite's IMAP sign-in/);
	assert.match(text("different_account"), /different Google account/);
	assert.match(text("address_taken"), /already connected/);
	for (const reason of ["expired", "admin_consent", "denied", "token", "no_address", "no_refresh_token", "failed"])
		assert.ok(!/Microsoft/.test(text(reason)), reason);
});

test("a refused Google sign-in says to sign in with Google again", () => {
	const problem = classifyConnectionError(new Error("IMAP sign-in failed: NO [AUTHENTICATIONFAILED] ya29.secret"), {
		refused: false,
		secrets: ["ya29.secret"],
		oauth: "google",
	});
	assert.equal(problem.kind, "auth");
	assert.match(problem.message, /Reconnect to sign in with Google again/);
	assert.ok(!problem.message.includes("ya29.secret"));
});

test("the dialog signs Gmail and Workspace in with Google when it is set up, unless an app password is chosen", () => {
	const both = { microsoft: true, google: true };
	const none = { microsoft: false, google: false };
	assert.equal(oauthSignInFor("gmail", null, both), "google");
	assert.equal(oauthSignInFor("google_workspace", null, both), "google");
	assert.equal(oauthSignInFor("gmail", null, both, true), null);
	assert.equal(oauthSignInFor("gmail", null, none), null);
	// A saved account keeps how it signs in; one with an app password is offered Google next to its password.
	assert.equal(oauthSignInFor("gmail", { authKind: "password" }, both), null);
	assert.equal(oauthSignInFor("gmail", { authKind: "oauth_google" }, none), "google");
	assert.equal(oauthSignInFor("gmail", { authKind: "oauth_google" }, both, true), null);
	// Microsoft as before; other providers never.
	assert.equal(oauthSignInFor("microsoft", null, both), "microsoft");
	assert.equal(oauthSignInFor("microsoft", { authKind: "oauth_microsoft" }, none), "microsoft");
	assert.equal(oauthSignInFor("microsoft", null, { microsoft: false, google: true }), null);
	assert.equal(oauthSignInFor("icloud", null, both), null);
	assert.equal(submitLabel(null, false, "google"), "Sign in with Google");
	assert.equal(submitLabel("oauth", false, "google"), "Opening Google…");
	assert.equal(submitLabel(null, false, "microsoft"), "Sign in with Microsoft");
	assert.equal(submitLabel("oauth", false, "microsoft"), "Opening Microsoft…");
	assert.equal(
		statusHint({ status: "auth_failed", statusReason: null, authKind: "oauth_google" }),
		"Google sign-in expired or was revoked. Reconnect to sign in with Google again.",
	);
});
