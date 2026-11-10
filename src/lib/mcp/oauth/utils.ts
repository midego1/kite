/**
 * MCP over OAuth 2.1, the pure parts: lifetimes and limits, redirect URI and registration checks (RFC 7591, RFC 8252),
 * PKCE S256 (RFC 7636), token generation and hashing, the resource indicator (RFC 8707), the authorization request's
 * validation, and the metadata documents (RFC 8414, RFC 9728). Nothing here reads the database.
 */

/** Access tokens live an hour; the client refreshes them. */
export const OAUTH_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
/** A refresh token lives 30 days and is replaced by every refresh, so a client used once a month stays connected. */
export const OAUTH_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Clients redeem the code at once; two minutes leaves room for a slow loopback hand-off. */
export const OAUTH_CODE_TTL_SECONDS = 2 * 60;
/** @public Exercised by the unit tests. */
export const OAUTH_MAX_REDIRECT_URIS = 5;
/** @public Exercised by the unit tests. */
export const OAUTH_MAX_REDIRECT_URI_LENGTH = 1024;
/** @public Exercised by the unit tests. */
export const OAUTH_MAX_CLIENT_NAME_LENGTH = 100;
/** @public Exercised by the unit tests. */
export const OAUTH_MAX_STATE_LENGTH = 1024;
/** The largest registration or token request body read. */
export const OAUTH_MAX_BODY_BYTES = 16 * 1024;
/**
 * Registrations made in the last `OAUTH_UNUSED_CLIENT_TTL_SECONDS` and not used yet, in all and per network; past
 * either, new ones are refused. Older unused ones no longer count and are removed, so a flood ends within the hour.
 */
export const OAUTH_MAX_UNUSED_CLIENTS = 1000;
export const OAUTH_MAX_UNUSED_CLIENTS_PER_NETWORK = 20;
/** A registration never used for a grant is removed after an hour, one whose grants are all gone after 30 days. */
export const OAUTH_UNUSED_CLIENT_TTL_SECONDS = 60 * 60;
export const OAUTH_IDLE_CLIENT_TTL_SECONDS = 30 * 24 * 60 * 60;
/**
 * A refresh token presented again this soon after it was rotated gets the same new pair instead of revoking the
 * grant: two processes of one client refreshing at nearly the same time is common and is not theft.
 */
export const OAUTH_REFRESH_GRACE_SECONDS = 60;
/** Connected apps one user may have; the oldest is disconnected when a new one is approved. */
export const OAUTH_MAX_GRANTS_PER_USER = 50;

export const OAUTH_ACCESS_TOKEN_PREFIX = "kite_at_";
export const OAUTH_REFRESH_TOKEN_PREFIX = "kite_rt_";
export const OAUTH_CLIENT_ID_PREFIX = "mcpc_";
/** @public Exercised by the unit tests. The scope the consent screen ticks by default when the client asks for it: reading, never writing. */
export const OAUTH_DEFAULT_SCOPE = "mcp:read";

export type OAuthClient = { id: string; name: string; redirectUris: string[] };

export type OAuthErrorCode =
	| "invalid_request"
	| "invalid_client"
	| "invalid_grant"
	| "unauthorized_client"
	| "unsupported_grant_type"
	| "unsupported_response_type"
	| "invalid_scope"
	| "invalid_target"
	| "access_denied"
	| "invalid_redirect_uri"
	| "invalid_client_metadata"
	| "temporarily_unavailable";

/** An OAuth error answer: `error` and `error_description` (RFC 6749 §5.2, RFC 7591 §3.2.2). */
export class OAuthError extends Error {
	constructor(
		readonly code: OAuthErrorCode,
		readonly description: string,
		readonly status = 400,
	) {
		super(description);
	}
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** @public Exercised by the unit tests. `localhost`, `127.0.0.1` or `[::1]` (RFC 8252 §7.3). */
export function isLoopbackHost(hostname: string): boolean {
	return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/**
 * @public Exercised by the unit tests. A redirect URI a client may register: https anywhere, or http on a loopback host only (RFC 8252 §7.3, §8.3), with
 * no user info and no fragment (RFC 6749 §3.1.2). It is stored as given and later matched character for character,
 * so `http://127.0.0.1:3000/cb` and `http://127.0.0.1:3000/cb/` are different URIs. Private-use schemes are refused.
 */
export function isAllowedRedirectUri(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > OAUTH_MAX_REDIRECT_URI_LENGTH) return false;
	// No whitespace or control characters anywhere: the URI is compared and rebuilt as a string.
	if (/[\s\u0000-\u001f\u007f]/.test(value) || value.includes("#")) return false;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.username || url.password || !url.hostname) return false;
	if (url.protocol === "https:") return true;
	return url.protocol === "http:" && isLoopbackHost(url.hostname);
}

/**
 * @public Exercised by the unit tests. Whether `given` is the registered redirect URI `registered`: the same string, or for a loopback http URI the same
 * one on any port, since native apps listen on whatever port is free (RFC 8252 §7.3).
 */
export function redirectUriMatches(registered: string, given: string): boolean {
	if (registered === given) return true;
	if (!isAllowedRedirectUri(given)) return false;
	try {
		const want = new URL(registered);
		const got = new URL(given);
		return (
			want.protocol === "http:" &&
			got.protocol === "http:" &&
			isLoopbackHost(want.hostname) &&
			want.hostname.toLowerCase() === got.hostname.toLowerCase() &&
			want.pathname === got.pathname &&
			want.search === got.search
		);
	} catch {
		return false;
	}
}

/** The host a consent screen names for a redirect URI: where the browser is sent back to. */
export function redirectUriHost(value: string): string {
	try {
		return new URL(value).host;
	} catch {
		return value;
	}
}

/** @public Exercised by the unit tests. Drops control characters and outer space from a self-asserted client name and caps its length. */
export function cleanClientName(value: unknown): string {
	const text = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮]/g, "") : "";
	const trimmed = text.trim().slice(0, OAUTH_MAX_CLIENT_NAME_LENGTH).trim();
	return trimmed || "MCP client";
}

export type ClientRegistration = { name: string; redirectUris: string[] };

/**
 * A Dynamic Client Registration request (RFC 7591 §2, §3.1) for a public client: `redirect_uris` is required, the
 * only token endpoint auth method is `none`, and only the authorization-code and refresh-token grants are offered.
 * Other metadata (logo, URIs, contacts) is ignored, so nothing the client sends is ever fetched or linked.
 */
export function parseClientRegistration(body: unknown): ClientRegistration {
	if (!body || typeof body !== "object" || Array.isArray(body))
		throw new OAuthError("invalid_client_metadata", "The registration must be a JSON object");
	const input = body as Record<string, unknown>;
	const uris = input.redirect_uris;
	if (!Array.isArray(uris) || uris.length === 0)
		throw new OAuthError("invalid_redirect_uri", "redirect_uris must list at least one URI");
	if (uris.length > OAUTH_MAX_REDIRECT_URIS)
		throw new OAuthError("invalid_redirect_uri", `At most ${OAUTH_MAX_REDIRECT_URIS} redirect URIs are allowed`);
	for (const uri of uris)
		if (!isAllowedRedirectUri(uri))
			throw new OAuthError(
				"invalid_redirect_uri",
				"Redirect URIs must be https, or http on localhost, 127.0.0.1 or [::1], without a fragment",
			);
	const method = input.token_endpoint_auth_method;
	if (method !== undefined && method !== "none")
		throw new OAuthError(
			"invalid_client_metadata",
			"Only public clients (token_endpoint_auth_method none) are supported",
		);
	const grantTypes = input.grant_types;
	if (
		grantTypes !== undefined &&
		(!Array.isArray(grantTypes) ||
			!grantTypes.every((type) => type === "authorization_code" || type === "refresh_token"))
	)
		throw new OAuthError(
			"invalid_client_metadata",
			"Only the authorization_code and refresh_token grants are supported",
		);
	const responseTypes = input.response_types;
	if (responseTypes !== undefined && (!Array.isArray(responseTypes) || !responseTypes.every((type) => type === "code")))
		throw new OAuthError("invalid_client_metadata", "Only the code response type is supported");
	if (input.client_name !== undefined && typeof input.client_name !== "string")
		throw new OAuthError("invalid_client_metadata", "client_name must be a string");
	return { name: cleanClientName(input.client_name), redirectUris: [...new Set(uris as string[])] };
}

/** The registration response (RFC 7591 §3.2.1). There is no client secret. */
export function registrationResponse(client: OAuthClient, issuedAt: Date) {
	return {
		client_id: client.id,
		client_id_issued_at: Math.floor(issuedAt.getTime() / 1000),
		client_name: client.name,
		redirect_uris: client.redirectUris,
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		token_endpoint_auth_method: "none",
	};
}

/** @public Exercised by the unit tests. The scopes of a space-separated `scope` parameter, once each, in order; null when absent or empty. */
export function parseScopeParam(value: string | null | undefined): string[] | null {
	if (typeof value !== "string") return null;
	const scopes = [...new Set(value.split(" ").filter(Boolean))];
	return scopes.length ? scopes : null;
}

/**
 * @public Exercised by the unit tests. The scopes the consent screen offers: what the client asked for, among those Kite supports, in Kite's order. A
 * client that names no scope is offered every supported one. Unknown scopes are left out (RFC 6749 §3.3).
 */
export function offeredScopes(requested: readonly string[] | null, supported: readonly string[]): string[] {
	if (!requested) return [...supported];
	return supported.filter((scope) => requested.includes(scope));
}

/** Least privilege: only reading is ticked, and only when it is on offer. */
export function defaultCheckedScopes(offered: readonly string[]): string[] {
	return offered.includes(OAUTH_DEFAULT_SCOPE) ? [OAUTH_DEFAULT_SCOPE] : [];
}

/** The origin Kite is reached at: `APP_URL` when set, otherwise the request's own. */
export function oauthIssuer(appUrl: string | undefined, requestUrl: string): string {
	if (appUrl) {
		try {
			return new URL(appUrl).origin;
		} catch {
			// An unparsable APP_URL falls back to the request, as the MCP route's own host check does.
		}
	}
	return new URL(requestUrl).origin;
}

/** The MCP endpoint, which is the protected resource every token is bound to (RFC 8707). */
export function mcpResourceUrl(issuer: string): string {
	return `${issuer}/mcp`;
}

/** @public Exercised by the unit tests. The Protected Resource Metadata of `/mcp` (RFC 9728 §3.1: the well-known path with the resource's path after it). */
export function protectedResourceMetadataUrl(issuer: string): string {
	return `${issuer}/.well-known/oauth-protected-resource/mcp`;
}

/**
 * Whether a `resource` parameter names Kite's MCP endpoint. A client that sends none gets a token bound to it anyway;
 * one that names anything else (another path, host or a query) is refused with `invalid_target`.
 */
export function resourceMatches(value: string | null | undefined, resource: string): boolean {
	if (value === null || value === undefined || value === "") return true;
	return value === resource || value === `${resource}/`;
}

const CODE_CHALLENGE = /^[A-Za-z0-9._~-]{43,128}$/;
const CODE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

/** @public Exercised by the unit tests. */
export function isValidCodeChallenge(value: unknown): value is string {
	return typeof value === "string" && CODE_CHALLENGE.test(value);
}

function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** @public Exercised by the unit tests. Equal strings in time that depends only on their length. */
export function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let difference = 0;
	for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
	return difference === 0;
}

/** RFC 7636 §4.6 with S256 only: BASE64URL(SHA256(verifier)) equals the stored challenge. */
export async function verifyPkce(verifier: unknown, challenge: string): Promise<boolean> {
	if (typeof verifier !== "string" || !CODE_VERIFIER.test(verifier)) return false;
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
	return constantTimeEqual(base64Url(digest), challenge);
}

/** 32 random bytes, base64url, after `prefix`. */
export function randomOAuthToken(prefix = ""): string {
	return `${prefix}${base64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

/** What the database keeps of a code or token: its SHA-256, hex. The tokens are random, so no salt is needed. */
export async function hashOAuthToken(token: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The redirect URI with the response parameters added to its own query, as RFC 6749 §4.1.2 asks. */
export function authorizationRedirect(redirectUri: string, params: Record<string, string | null | undefined>): string {
	const url = new URL(redirectUri);
	for (const [name, value] of Object.entries(params)) if (value) url.searchParams.set(name, value);
	return url.toString();
}

/** @public Exercised by the unit tests. The authorization request as the consent screen and the decision route both validate it. */
export type AuthorizationRequest = {
	clientId: string;
	redirectUri: string;
	state: string | null;
	codeChallenge: string;
	resource: string;
	/** Whether the request named `redirectUri` (else the single registered one); the token request must repeat it. */
	redirectUriSent: boolean;
	/** The scopes on offer (`offeredScopes`). */
	scopes: string[];
};

export type AuthorizationCheck =
	| { kind: "ok"; request: AuthorizationRequest }
	/** No usable client or redirect URI: shown in Kite, never redirected (RFC 6749 §4.1.2.1). */
	| { kind: "fatal"; message: string }
	/** Everything else goes back to the client's redirect URI. */
	| { kind: "redirect"; redirectUri: string; error: OAuthErrorCode; description: string; state: string | null };

type ParamReader = { get(name: string): string | null };

/**
 * Validates an authorization request (RFC 6749 §4.1.1, OAuth 2.1 §4.1.1, RFC 7636, RFC 8707). `client` is the
 * registration `client_id` names, or null. The redirect URI must match a registered one exactly (a loopback one on
 * any port); when the client registered just one, it may be left out.
 */
export function checkAuthorizationRequest(
	params: ParamReader,
	client: OAuthClient | null,
	resource: string,
	supportedScopes: readonly string[],
): AuthorizationCheck {
	if (!client) return { kind: "fatal", message: "This app is not registered with Kite, or its registration expired." };
	const given = params.get("redirect_uri");
	const redirectUri = given ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : null);
	if (!redirectUri || !client.redirectUris.some((registered) => redirectUriMatches(registered, redirectUri)))
		return { kind: "fatal", message: "The app sent a redirect address it did not register." };
	const rawState = params.get("state");
	const state = rawState && rawState.length <= OAUTH_MAX_STATE_LENGTH ? rawState : null;
	const fail = (error: OAuthErrorCode, description: string): AuthorizationCheck => ({
		kind: "redirect",
		redirectUri,
		error,
		description,
		state,
	});
	if (rawState && !state) return fail("invalid_request", "state is too long");
	if (params.get("response_type") !== "code") return fail("unsupported_response_type", "response_type must be code");
	const challenge = params.get("code_challenge");
	if (!isValidCodeChallenge(challenge)) return fail("invalid_request", "A PKCE code_challenge is required");
	if (params.get("code_challenge_method") !== "S256")
		return fail("invalid_request", "code_challenge_method must be S256");
	if (!resourceMatches(params.get("resource"), resource))
		return fail("invalid_target", "resource must be this server's MCP endpoint");
	const scopes = offeredScopes(parseScopeParam(params.get("scope")), supportedScopes);
	if (!scopes.length) return fail("invalid_scope", "None of the requested scopes is supported");
	return {
		kind: "ok",
		request: {
			clientId: client.id,
			redirectUri,
			redirectUriSent: given !== null,
			state,
			codeChallenge: challenge,
			resource,
			scopes,
		},
	};
}

/** The `WWW-Authenticate` challenge of `/mcp` (RFC 6750 §3, RFC 9728 §5.1). */
export function mcpAuthenticateHeader(issuer: string, invalidToken: boolean): string {
	const parts = [`resource_metadata="${protectedResourceMetadataUrl(issuer)}"`];
	if (invalidToken) parts.push('error="invalid_token"');
	return `Bearer ${parts.join(", ")}`;
}

/** RFC 9728 §2. */
export function protectedResourceMetadata(issuer: string, scopes: readonly string[]) {
	return {
		resource: mcpResourceUrl(issuer),
		authorization_servers: [issuer],
		scopes_supported: [...scopes],
		bearer_methods_supported: ["header"],
		resource_name: "Kite",
	};
}

/** RFC 8414 §2. */
export function authorizationServerMetadata(issuer: string, scopes: readonly string[]) {
	return {
		issuer,
		authorization_endpoint: `${issuer}/oauth/authorize`,
		token_endpoint: `${issuer}/api/oauth/token`,
		registration_endpoint: `${issuer}/api/oauth/register`,
		revocation_endpoint: `${issuer}/api/oauth/revoke`,
		scopes_supported: [...scopes],
		response_types_supported: ["code"],
		response_modes_supported: ["query"],
		grant_types_supported: ["authorization_code", "refresh_token"],
		token_endpoint_auth_methods_supported: ["none"],
		revocation_endpoint_auth_methods_supported: ["none"],
		code_challenge_methods_supported: ["S256"],
		authorization_response_iss_parameter_supported: true,
	};
}

/** The token response (RFC 6749 §5.1). */
export function tokenResponse(
	accessToken: string,
	refreshToken: string,
	scopes: readonly string[],
	expiresIn = OAUTH_ACCESS_TOKEN_TTL_SECONDS,
) {
	return {
		access_token: accessToken,
		token_type: "Bearer",
		expires_in: expiresIn,
		refresh_token: refreshToken,
		scope: scopes.join(" "),
	};
}

/**
 * The network a registration came from, for the per-network cap: an IPv4 address's /24 or an IPv6 address's /48,
 * `unknown` without one. Only its hash is stored.
 */
export function clientNetwork(ip: string | null | undefined): string {
	const value = (ip ?? "").trim().toLowerCase();
	const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(value);
	if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
	if (!value.includes(":") || !/^[0-9a-f:.]+$/.test(value)) return "unknown";
	const [head, tail = ""] = value.split("::");
	if (value.split("::").length > 2) return "unknown";
	const headGroups = head ? head.split(":") : [];
	const tailGroups = tail ? tail.split(":") : [];
	const missing = 8 - headGroups.length - tailGroups.length;
	const groups = value.includes("::")
		? [...headGroups, ...Array<string>(Math.max(missing, 0)).fill("0"), ...tailGroups]
		: headGroups;
	if (groups.length < 3) return "unknown";
	return `${groups
		.slice(0, 3)
		.map((group) => group.replace(/^0+(?=.)/, ""))
		.join(":")}::/48`;
}

/** The pair a refresh issued, as the grace window hands it out again. */
export type SuccessorPair = { accessToken: string; refreshToken: string; accessExpiresAt: number };

async function successorKey(refreshToken: string, usage: KeyUsage): Promise<CryptoKey> {
	// Not the stored hash: that is SHA-256 of the token alone, so the database never holds this key.
	const material = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(`kite-mcp-successor:${refreshToken}`),
	);
	return crypto.subtle.importKey("raw", material, "AES-GCM", false, [usage]);
}

/** Seals a refresh's new pair under a key only the rotated refresh token yields (AES-GCM). */
export async function sealSuccessor(refreshToken: string, pair: SuccessorPair): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const sealed = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		await successorKey(refreshToken, "encrypt"),
		new TextEncoder().encode(JSON.stringify(pair)),
	);
	const bytes = new Uint8Array(iv.length + sealed.byteLength);
	bytes.set(iv);
	bytes.set(new Uint8Array(sealed), iv.length);
	return base64Url(bytes);
}

/** The pair `sealSuccessor` sealed, or null when the token or the value does not fit. */
export async function openSuccessor(refreshToken: string, sealed: string): Promise<SuccessorPair | null> {
	try {
		const bytes = Uint8Array.from(atob(sealed.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
		const opened = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: bytes.slice(0, 12) },
			await successorKey(refreshToken, "decrypt"),
			bytes.slice(12),
		);
		const pair = JSON.parse(new TextDecoder().decode(opened)) as Partial<SuccessorPair>;
		return typeof pair.accessToken === "string" &&
			typeof pair.refreshToken === "string" &&
			typeof pair.accessExpiresAt === "number"
			? { accessToken: pair.accessToken, refreshToken: pair.refreshToken, accessExpiresAt: pair.accessExpiresAt }
			: null;
	} catch {
		return null;
	}
}
