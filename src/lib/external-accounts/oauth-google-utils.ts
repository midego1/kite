/**
 * Sign in with Google for connected Gmail and Google Workspace accounts (spec §15.7): the pure parts. The authorize
 * URL (offline access, consent, PKCE S256), the token requests, the ID token's checks, the owner's OAuth client and
 * what Google's answer to a made-up code says about it. Nothing here reads the database or the network.
 */

import {
	asAddress,
	type ClientCheck,
	decodeJwtPayload,
	type OAuthEndpoints,
	type OAuthIdentity,
	oauthTokenBody,
	type TokenGrant,
} from "./oauth-utils";

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Gmail's one scope for IMAP and SMTP (restricted, spec §15.7). */
const GMAIL_SCOPE = "https://mail.google.com/";

/** @public Exercised by the unit tests. Gmail over IMAP and SMTP, and the ID token's verified address. */
export const GOOGLE_SCOPES = [GMAIL_SCOPE, "openid", "email"] as const;

/** Gmail's servers, for Gmail and Google Workspace accounts alike (the presets' own). */
export const GOOGLE_IMAP = { host: "imap.gmail.com", port: 993, security: "tls" } as const;
export const GOOGLE_SMTP = { host: "smtp.gmail.com", port: 465, security: "tls" } as const;

/**
 * Google's issuers of an ID token: both forms are documented and both are Google's ("The value of iss in the ID token
 * is equal to accounts.google.com or https://accounts.google.com").
 */
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

/** Clock skew allowed between Google and this server: for `exp` in the past and `iat` in the future. */
const ID_TOKEN_SKEW_MS = 5 * 60_000;

/**
 * The owner's Google Cloud OAuth client (type Web application). `hostedDomain` restricts sign-in to one Google
 * Workspace domain (the ID token's `hd`); null allows any Google account, Gmail included.
 */
export type GoogleClient = { clientId: string; clientSecret: string; hostedDomain: string | null };

const CLIENT_ID = /^[0-9]{1,30}-[a-z0-9]{1,100}\.apps\.googleusercontent\.com$/;
const DOMAIN = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export type GoogleClientInput = { ok: true; client: GoogleClient } | { ok: false; error: string };

/** The owner's OAuth client as entered in Admin → General, checked for shape only. */
export function parseGoogleClientInput(body: unknown): GoogleClientInput {
	const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
	const clientId = typeof input.clientId === "string" ? input.clientId.trim().toLowerCase() : "";
	const clientSecret = typeof input.clientSecret === "string" ? input.clientSecret.trim() : "";
	const domainText = typeof input.hostedDomain === "string" ? input.hostedDomain.trim().toLowerCase() : "";
	if (!CLIENT_ID.test(clientId))
		return { ok: false, error: "Enter the Client ID, which ends in .apps.googleusercontent.com" };
	if (!clientSecret || clientSecret.length > 512 || /[\s\0-\x1f\x7f]/.test(clientSecret))
		return { ok: false, error: "Enter the client secret of this OAuth client" };
	if (domainText && !DOMAIN.test(domainText))
		return { ok: false, error: "Enter a Google Workspace domain such as example.com, or leave it empty" };
	return { ok: true, client: { clientId, clientSecret, hostedDomain: domainText || null } };
}

/** The saved OAuth client (opened JSON), or null when it is missing or not one. */
export function parseStoredGoogleClient(json: string | null): GoogleClient | null {
	if (!json) return null;
	try {
		const parsed = parseGoogleClientInput(JSON.parse(json));
		return parsed.ok ? parsed.client : null;
	} catch {
		return null;
	}
}

/** Google's authorize and token endpoints, or the e2e fake's under `/google` on the test origin. */
export function googleEndpoints(testOrigin: string | null = null): OAuthEndpoints {
	if (testOrigin) return { authorize: `${testOrigin}/google/o/oauth2/v2/auth`, token: `${testOrigin}/google/token` };
	return { authorize: GOOGLE_AUTHORIZE_URL, token: GOOGLE_TOKEN_URL };
}

/**
 * The URL that starts a sign-in at Google: offline access and `prompt=consent`, so Google issues a refresh token
 * every time (also on a reconnect); `login_hint` pre-fills the address and `hd` the Workspace domain (only a hint:
 * the ID token's `hd` is what counts).
 */
export function googleAuthorizeUrl(input: {
	endpoints: OAuthEndpoints;
	clientId: string;
	redirectUri: string;
	state: string;
	challenge: string;
	loginHint?: string | null;
	hostedDomain?: string | null;
}): string {
	const url = new URL(input.endpoints.authorize);
	url.searchParams.set("client_id", input.clientId);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("redirect_uri", input.redirectUri);
	url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
	url.searchParams.set("state", input.state);
	url.searchParams.set("code_challenge", input.challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("access_type", "offline");
	url.searchParams.set("prompt", "consent");
	if (input.loginHint) url.searchParams.set("login_hint", input.loginHint);
	if (input.hostedDomain) url.searchParams.set("hd", input.hostedDomain);
	return url.toString();
}

/** The form body of an authorization-code redemption (with the PKCE verifier) or of a refresh; Google takes no scope. */
export function googleTokenRequestBody(
	client: Pick<GoogleClient, "clientId" | "clientSecret">,
	grant: TokenGrant,
): URLSearchParams {
	return oauthTokenBody(client, grant);
}

/**
 * Whether the scopes granted cover Gmail. Google lets the user untick a scope on its consent screen, and a sign-in
 * without Gmail cannot sync. Each space-separated scope is compared whole, never as a substring.
 */
export function grantsGmail(scopes: string): boolean {
	return scopes.split(/\s+/).some((scope) => scope === GMAIL_SCOPE);
}

export type GoogleIdentity =
	{ ok: true; identity: OAuthIdentity } | { ok: false; reason: "no_address" | "wrong_domain" };

const audienceOf = (aud: unknown): string[] =>
	typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud.filter((item) => typeof item === "string") : [];

/**
 * The address and stable user id (`sub`) the ID token names. The token came straight from Google's token endpoint
 * over TLS, so its signature need not be checked (OpenID Connect Core §3.1.3.7); it must be Google's (`iss`), for this
 * client (`aud`, and `azp` when present, which it must be when `aud` names several), issued now (`iat` not in the
 * future) and not expired, with a verified address (`email_verified`), and, when the owner restricted sign-in to a
 * Workspace domain, from that domain (`hd`, which only Workspace accounts carry). The IMAP sign-in with that address
 * is still the proof that it is the mailbox's.
 */
export function googleIdTokenClaims(idToken: string | null, client: GoogleClient, now: Date): GoogleIdentity {
	const claims = decodeJwtPayload(idToken);
	if (!claims || !issuedForClient(claims, client.clientId) || !current(claims, now))
		return { ok: false, reason: "no_address" };
	const sub = typeof claims.sub === "string" && /^[\x21-\x7e]{1,255}$/.test(claims.sub) ? claims.sub : null;
	const verified = claims.email_verified === true || claims.email_verified === "true";
	const address = verified ? asAddress(claims.email) : null;
	if (!sub || !address) return { ok: false, reason: "no_address" };
	if (client.hostedDomain) {
		const hd = typeof claims.hd === "string" ? claims.hd.trim().toLowerCase() : "";
		if (hd !== client.hostedDomain) return { ok: false, reason: "wrong_domain" };
	}
	return { ok: true, identity: { address, subject: sub } };
}

/**
 * Google's token, for this client: a Google issuer, this client among the audiences, and the authorized party this
 * client when there is one, which there must be when the audiences are several (OpenID Connect Core §2).
 */
function issuedForClient(claims: Record<string, unknown>, clientId: string): boolean {
	if (typeof claims.iss !== "string" || !GOOGLE_ISSUERS.has(claims.iss)) return false;
	const audience = audienceOf(claims.aud);
	if (!audience.includes(clientId)) return false;
	if (claims.azp === undefined) return audience.length === 1;
	return claims.azp === clientId;
}

/** Issued now: not expired, and not issued in the future, both within the clock skew. */
function current(claims: Record<string, unknown>, now: Date): boolean {
	if (typeof claims.exp !== "number" || claims.exp * 1000 < now.getTime() - ID_TOKEN_SKEW_MS) return false;
	return typeof claims.iat === "number" && claims.iat * 1000 <= now.getTime() + ID_TOKEN_SKEW_MS;
}

/** Google's own error on the redirect (`error`): cancelled, blocked by a Workspace policy, or refused. */
export function googleAuthorizeFailure(error: string): "cancelled" | "admin_consent" | "denied" {
	if (error === "access_denied") return "cancelled";
	if (error === "admin_policy_enforced" || error === "org_internal") return "admin_consent";
	return "denied";
}

/**
 * What saving the OAuth client learnt from redeeming a made-up code (`validateGoogleClient`): an unknown client ID or
 * a refused secret is `rejected`, any answer about the made-up code (`invalid_grant`) `ok`, and `unverified` when
 * Google could not be reached.
 */
export function googleClientCheckVerdict(status: number, body: unknown): ClientCheck {
	if (status >= 200 && status < 300) return { verdict: "ok" };
	const data = (body && typeof body === "object" ? body : {}) as { error?: unknown; error_description?: unknown };
	const error = typeof data.error === "string" ? data.error : null;
	const description = typeof data.error_description === "string" ? data.error_description : "";
	if (error === "invalid_client" && /not found/i.test(description))
		return {
			verdict: "rejected",
			error:
				"Google knows no OAuth client with this Client ID (invalid_client). Copy it from Google Auth Platform → Clients.",
		};
	if (error === "invalid_client")
		return {
			verdict: "rejected",
			error: "Google refused the client secret (invalid_client). Copy the secret of this client, or add a new one.",
		};
	if (error === "unauthorized_client")
		return {
			verdict: "rejected",
			error:
				"Google does not allow this client to sign in here (unauthorized_client). Create a client of type Web application.",
		};
	if (status >= 500 || status === 429) return { verdict: "unverified" };
	return { verdict: "ok" };
}
