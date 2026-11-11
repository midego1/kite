/**
 * Sign in with Microsoft for connected accounts (spec §15): the pure parts. The authorization-code flow with PKCE and
 * a single-use state, the token endpoint's answers and errors, the ID token's address, when to refresh, and the
 * owner's app registration. Nothing here reads the database or the network.
 */

/** Where Microsoft's sign-in and token endpoints live; a tenant (never anything else) goes into the path. */
const MICROSOFT_LOGIN_ORIGIN = "https://login.microsoftonline.com";

/** @public Exercised by the unit tests. IMAP and SMTP over XOAUTH2, a refresh token, and the ID token's address (spec §15.2). */
export const MICROSOFT_SCOPES = [
	"https://outlook.office.com/IMAP.AccessAsUser.All",
	"https://outlook.office.com/SMTP.Send",
	"offline_access",
	"openid",
	"email",
] as const;

/** The scopes a refresh asks for again: the Outlook resource only (OpenID scopes are not resource scopes). */
const MICROSOFT_REFRESH_SCOPES = [
	"https://outlook.office.com/IMAP.AccessAsUser.All",
	"https://outlook.office.com/SMTP.Send",
	"offline_access",
] as const;

/** Microsoft's servers for a connected Outlook.com or Microsoft 365 account (the `microsoft` preset). */
export const MICROSOFT_IMAP = { host: "outlook.office365.com", port: 993, security: "tls" } as const;
export const MICROSOFT_SMTP = { host: "smtp.office365.com", port: 587, security: "starttls" } as const;

const OAUTH_CALLBACK_PATH = "/api/external-accounts/oauth/callback";
/** A sign-in started must come back within this, once (spec §10.4). */
export const OAUTH_STATE_TTL_MS = 10 * 60_000;
/** @public Exercised by the unit tests. A cached access token is used until this long before it expires; then it is refreshed (spec §15.3). */
export const ACCESS_TOKEN_MARGIN_MS = 5 * 60_000;

/**
 * `tenantId` is only ever set on a registration saved with a tenant domain: the tenant ID of its first successful
 * sign-in, which every later sign-in must match (`pinMicrosoftTenant`). Entering the registration again clears it.
 */
export type MicrosoftClient = { clientId: string; clientSecret: string; tenant: string; tenantId?: string };

export type OAuthEndpoints = { authorize: string; token: string };

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_NAMES = new Set(["common", "organizations", "consumers"]);
const TENANT_DOMAIN = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** `common` (work, school and personal accounts), `organizations`, `consumers`, a tenant id or a tenant domain. */
export function isTenant(value: string): boolean {
	return TENANT_NAMES.has(value) || GUID.test(value) || TENANT_DOMAIN.test(value);
}

export type MicrosoftClientInput = { ok: true; client: MicrosoftClient } | { ok: false; error: string };

/** The owner's Entra app registration as entered in Admin → General, checked for shape only. */
export function parseMicrosoftClientInput(body: unknown): MicrosoftClientInput {
	const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
	const clientId = typeof input.clientId === "string" ? input.clientId.trim().toLowerCase() : "";
	const clientSecret = typeof input.clientSecret === "string" ? input.clientSecret.trim() : "";
	const tenantText = typeof input.tenant === "string" ? input.tenant.trim().toLowerCase() : "";
	const tenant = tenantText || "common";
	if (!GUID.test(clientId))
		return { ok: false, error: "Enter the Application (client) ID, a GUID like 00000000-0000-0000-0000-000000000000" };
	if (!clientSecret || clientSecret.length > 512 || /[\s\0-\x1f\x7f]/.test(clientSecret))
		return { ok: false, error: "Enter the client secret's Value (not its Secret ID)" };
	if (!isTenant(tenant))
		return { ok: false, error: "Enter common, organizations, consumers, a tenant ID or a tenant domain" };
	return { ok: true, client: { clientId, clientSecret, tenant } };
}

/** A tenant named by its domain: Microsoft answers for it whatever its ID, so the ID is learnt from the first sign-in. */
export function isTenantDomain(tenant: string): boolean {
	return !TENANT_NAMES.has(tenant) && !GUID.test(tenant);
}

/** The saved registration (opened JSON), or null when it is missing or not one. */
export function parseStoredMicrosoftClient(json: string | null): MicrosoftClient | null {
	if (!json) return null;
	try {
		const raw = JSON.parse(json) as { tenantId?: unknown } | null;
		const parsed = parseMicrosoftClientInput(raw);
		if (!parsed.ok) return null;
		const pinned = typeof raw?.tenantId === "string" ? raw.tenantId.toLowerCase() : "";
		return GUID.test(pinned) && isTenantDomain(parsed.client.tenant)
			? { ...parsed.client, tenantId: pinned }
			: parsed.client;
	} catch {
		return null;
	}
}

/**
 * `EXTERNAL_OAUTH_TEST_ORIGIN`, outside production only and only on http loopback: the fake that stands in for
 * Microsoft's endpoints in the e2e tests (spec §14.3). Null everywhere else.
 */
export function oauthTestOrigin(value: string | undefined, nodeEnv: string | undefined): string | null {
	if (!value?.trim() || nodeEnv === "production") return null;
	try {
		const url = new URL(value.trim());
		return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ? url.origin : null;
	} catch {
		return null;
	}
}

/** The authorize and token endpoints of a tenant (v2.0), on the test origin when there is one. */
export function microsoftEndpoints(tenant: string, testOrigin: string | null = null): OAuthEndpoints {
	if (!isTenant(tenant)) throw new Error("Invalid Microsoft tenant");
	const base = `${testOrigin ?? MICROSOFT_LOGIN_ORIGIN}/${encodeURIComponent(tenant)}/oauth2/v2.0`;
	return { authorize: `${base}/authorize`, token: `${base}/token` };
}

/**
 * The redirect URI Microsoft sends the browser back to: under APP_URL when it is a usable http(s) address, else the
 * request's own origin (development). It must match one registered on the app exactly.
 */
export function oauthRedirectUri(appUrl: string | undefined, requestOrigin: string): string {
	const configured = appUrl?.trim();
	if (configured) {
		try {
			const url = new URL(configured);
			if (url.protocol === "https:" || url.protocol === "http:")
				return `${url.origin}${url.pathname.replace(/\/+$/, "")}${OAUTH_CALLBACK_PATH}`;
		} catch {
			// An unusable APP_URL falls back to the request's origin.
		}
	}
	return `${new URL(requestOrigin).origin}${OAUTH_CALLBACK_PATH}`;
}

function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 32 random bytes, base64url: a state or a PKCE code verifier (43 characters, RFC 7636 §4.1). */
export function randomUrlToken(): string {
	return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The S256 code challenge of a verifier (RFC 7636 §4.2). */
export async function pkceChallenge(verifier: string): Promise<string> {
	if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new Error("Invalid PKCE code verifier");
	return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

/** The key a state is stored under: its SHA-256, hex, so the database never holds a usable state. */
export async function hashOAuthState(state: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(state)));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A state as the callback received it: what `randomUrlToken` makes, or null. */
export function parseCallbackState(value: string | null): string | null {
	return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

/** The URL that starts a sign-in at Microsoft. `loginHint` pre-fills the address; `prompt` forces account choice. */
export function microsoftAuthorizeUrl(input: {
	endpoints: OAuthEndpoints;
	clientId: string;
	redirectUri: string;
	state: string;
	challenge: string;
	loginHint?: string | null;
}): string {
	const url = new URL(input.endpoints.authorize);
	url.searchParams.set("client_id", input.clientId);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("redirect_uri", input.redirectUri);
	url.searchParams.set("response_mode", "query");
	url.searchParams.set("scope", MICROSOFT_SCOPES.join(" "));
	url.searchParams.set("state", input.state);
	url.searchParams.set("code_challenge", input.challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("prompt", "select_account");
	if (input.loginHint) url.searchParams.set("login_hint", input.loginHint);
	return url.toString();
}

/** A token request's grant: an authorization code with its PKCE verifier, or a refresh token. */
export type TokenGrant =
	| { kind: "authorization_code"; code: string; verifier: string; redirectUri: string }
	| { kind: "refresh_token"; refreshToken: string };

/**
 * The form body of a token request at any provider: the client, then the grant, then `scopes` (the `scope` parameter
 * of a code redemption and of a refresh) when the provider wants one.
 */
export function oauthTokenBody(
	client: { clientId: string; clientSecret: string },
	grant: TokenGrant,
	scopes?: { code: string; refresh: string },
): URLSearchParams {
	const body = new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret });
	if (grant.kind === "authorization_code") {
		body.set("grant_type", "authorization_code");
		body.set("code", grant.code);
		body.set("code_verifier", grant.verifier);
		body.set("redirect_uri", grant.redirectUri);
	} else {
		body.set("grant_type", "refresh_token");
		body.set("refresh_token", grant.refreshToken);
	}
	if (scopes) body.set("scope", grant.kind === "authorization_code" ? scopes.code : scopes.refresh);
	return body;
}

/** The form body of an authorization-code redemption (with the PKCE verifier) or of a refresh at Microsoft. */
export function tokenRequestBody(
	client: Pick<MicrosoftClient, "clientId" | "clientSecret">,
	grant: TokenGrant,
): URLSearchParams {
	return oauthTokenBody(client, grant, {
		code: MICROSOFT_SCOPES.join(" "),
		refresh: MICROSOFT_REFRESH_SCOPES.join(" "),
	});
}

export type OAuthTokens = {
	accessToken: string;
	/** Null when the answer carried none (a refresh may keep the old one). */
	refreshToken: string | null;
	expiresAt: Date;
	scopes: string;
	idToken: string | null;
};

/**
 * What a token request's failure means (spec §15.3): `reauth` the user must sign in again (revoked, expired, password
 * changed, consent withdrawn); `client` the install's app registration is refused (the owner must fix it); `transient`
 * Microsoft could not answer now.
 */
export type OAuthFailureKind = "reauth" | "client" | "transient";

/** A failed token request. The message is safe to show and store: never a token, a code or the client secret. */
export class OAuthTokenError extends Error {
	constructor(
		readonly kind: OAuthFailureKind,
		message: string,
		readonly code: string | null = null,
	) {
		super(message);
		this.name = "OAuthTokenError";
	}
}

/** `AADSTS70008` and the like from an error description; only the code is kept, never the rest of the text. */
export function aadstsCode(description: unknown): string | null {
	return typeof description === "string" ? (/\bAADSTS\d{4,7}\b/.exec(description)?.[0] ?? null) : null;
}

const REAUTH_ERRORS = new Set(["invalid_grant", "interaction_required", "consent_required", "login_required"]);
const CLIENT_ERRORS = new Set(["invalid_client", "unauthorized_client", "unsupported_grant_type"]);

/**
 * Sorts a token endpoint's error answer (or a status without a body). `provider` names who answered in the message;
 * Microsoft and Google use the same OAuth error codes.
 */
export function tokenFailure(status: number, body: unknown, provider = "Microsoft"): OAuthTokenError {
	const data = (body && typeof body === "object" ? body : {}) as { error?: unknown; error_description?: unknown };
	const error = typeof data.error === "string" ? data.error : null;
	const code = aadstsCode(data.error_description);
	const suffix = [error, code].filter(Boolean).join(", ");
	const detail = suffix ? ` (${suffix})` : ` (HTTP ${status})`;
	if (error && REAUTH_ERRORS.has(error))
		return new OAuthTokenError(
			"reauth",
			`${provider} sign-in expired or was revoked. Reconnect the account${detail}.`,
			code ?? error,
		);
	if (error && CLIENT_ERRORS.has(error))
		return new OAuthTokenError(
			"client",
			`${provider} refused this Kite's app registration. Ask your admin to check ${provider} sign-in in Admin → General${detail}.`,
			code ?? error,
		);
	if (status >= 500 || status === 429 || error === "temporarily_unavailable")
		return new OAuthTokenError("transient", `${provider} could not be reached. Kite tries again later${detail}.`, code);
	return new OAuthTokenError(
		"reauth",
		`${provider} refused the sign-in. Reconnect the account${detail}.`,
		code ?? error,
	);
}

/** A successful token answer, checked; `now` dates the expiry. */
export function parseTokenResponse(body: unknown, now: Date, provider = "Microsoft"): OAuthTokens {
	const data = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
	const accessToken = typeof data.access_token === "string" ? data.access_token : "";
	const type = typeof data.token_type === "string" ? data.token_type.toLowerCase() : "";
	const expiresIn = Number(data.expires_in);
	if (!accessToken || /[\s\0-\x1f\x7f]/.test(accessToken) || (type && type !== "bearer"))
		throw new OAuthTokenError("transient", `${provider} answered without a usable access token.`);
	const seconds = Number.isFinite(expiresIn) && expiresIn > 0 ? Math.min(expiresIn, 24 * 3600) : 3600;
	return {
		accessToken,
		refreshToken: typeof data.refresh_token === "string" && data.refresh_token ? data.refresh_token : null,
		expiresAt: new Date(now.getTime() + seconds * 1000),
		scopes: typeof data.scope === "string" ? data.scope : "",
		idToken: typeof data.id_token === "string" ? data.id_token : null,
	};
}

/**
 * Whether the scopes granted cover IMAP; a sign-in where the user (or a policy) left it out cannot sync. Microsoft
 * answers with the scopes as granted (sometimes without the resource prefix).
 */
export function grantsImap(scopes: string): boolean {
	return scopes.split(/\s+/).some((scope) => /(^|\/)IMAP\.AccessAsUser\.All$/i.test(scope));
}

/** Who signed in, as an ID token names them: the address, and the provider's stable id for the user. */
export type OAuthIdentity = { address: string; subject: string };

/** `subject` is `<tid>:<oid>`: the user's id is only unique within its tenant, so both are kept and compared. */
export type IdTokenClaims = OAuthIdentity & { tenantId: string };

/** The tenant of every personal Microsoft account (Outlook.com, Hotmail). */
const CONSUMER_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";

/** The claims of a JWT, unverified (the caller says why that is enough), or null when it is not one. */
export function decodeJwtPayload(idToken: string | null): Record<string, unknown> | null {
	const payload = idToken?.split(".")[1];
	if (!payload) return null;
	try {
		const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
		const binary = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="));
		const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))));
		return claims && typeof claims === "object" ? (claims as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/**
 * Whether the token's tenant fits the registration's: its own id, personal only, or work and school only. A tenant
 * domain fits any tenant until the first sign-in has pinned its ID (`pinned`), and only that one afterwards.
 */
function tenantMatches(tid: string, tenant: string, pinned: string | undefined): boolean {
	if (GUID.test(tenant)) return tid === tenant.toLowerCase();
	if (tenant === "consumers") return tid === CONSUMER_TENANT_ID;
	if (tenant === "organizations") return tid !== CONSUMER_TENANT_ID;
	if (tenant === "common") return true;
	return !pinned || tid === pinned.toLowerCase();
}

/** A claim as a lowercased mail address, or null. */
export const asAddress = (value: unknown) => {
	const text = typeof value === "string" ? value.trim().toLowerCase() : "";
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? text : null;
};

/**
 * The address, tenant and stable user id the ID token names. The token came straight from Microsoft's token endpoint
 * over TLS, so its signature need not be checked (OpenID Connect Core §3.1.3.7); its audience must be this app, and
 * its issuer the v2.0 issuer of the tenant it names, which must fit the registration's tenant (for a tenant given as
 * a domain, the ID its first sign-in pinned, when there is one). The address is the
 * name the user signed in as (`preferred_username`: the UPN of a work or school account, the sign-in address of a
 * personal one), never a plain `email` claim, which with the `common` endpoint can be an unverified value an
 * organisation set (spec §15.2); `email` counts only when Microsoft marks its domain verified (`xms_edov`). The IMAP
 * sign-in with that address is still the proof that it is the mailbox's.
 */
export function idTokenClaims(
	idToken: string | null,
	clientId: string,
	tenant = "common",
	pinnedTenantId?: string,
): IdTokenClaims | null {
	const claims = decodeJwtPayload(idToken);
	if (!claims) return null;
	if (typeof claims.aud !== "string" || claims.aud.toLowerCase() !== clientId.toLowerCase()) return null;
	const tid = typeof claims.tid === "string" ? claims.tid.toLowerCase() : "";
	if (!GUID.test(tid) || !tenantMatches(tid, tenant, pinnedTenantId)) return null;
	if (claims.iss !== `https://login.microsoftonline.com/${tid}/v2.0`) return null;
	const address = asAddress(claims.preferred_username) ?? (claims.xms_edov === true ? asAddress(claims.email) : null);
	const user = [claims.oid, claims.sub].find((value): value is string => typeof value === "string" && !!value);
	return address && user ? { address, subject: `${tid}:${user}`, tenantId: tid } : null;
}

/** Whether a cached access token must be refreshed first: none, unknown expiry, or within the margin. */
export function needsRefresh(expiresAt: Date | null, now: Date, hasToken: boolean): boolean {
	return !hasToken || !expiresAt || expiresAt.getTime() - now.getTime() <= ACCESS_TOKEN_MARGIN_MS;
}

/**
 * What saving the app registration learnt from redeeming a made-up code (`validateMicrosoftClient`): a client ID
 * Microsoft does not know, a refused secret or an unknown tenant is `rejected`; any other answer about the made-up code
 * (`invalid_grant`) is `ok`, which is as far as a check without a real sign-in goes. `unverified` when Microsoft could
 * not be reached; the registration is saved with a warning then.
 */
export type ClientCheck = { verdict: "ok" } | { verdict: "unverified" } | { verdict: "rejected"; error: string };

export function clientCheckVerdict(status: number, body: unknown): ClientCheck {
	if (status >= 200 && status < 300) return { verdict: "ok" };
	const data = (body && typeof body === "object" ? body : {}) as { error?: unknown; error_description?: unknown };
	const code = aadstsCode(data.error_description);
	const error = typeof data.error === "string" ? data.error : null;
	if (code === "AADSTS700016")
		return {
			verdict: "rejected",
			error: "Microsoft knows no app with this Application (client) ID in this tenant (AADSTS700016).",
		};
	if (code === "AADSTS7000215" || code === "AADSTS7000222" || code === "AADSTS7000218" || error === "invalid_client")
		return {
			verdict: "rejected",
			error: `Microsoft refused the client secret${code ? ` (${code})` : ""}. Copy the secret's Value, not its Secret ID, or create a new one.`,
		};
	if (code === "AADSTS90002" || code === "AADSTS900023" || code === "AADSTS90023")
		return { verdict: "rejected", error: `Microsoft does not know this tenant${code ? ` (${code})` : ""}.` };
	if (error === "unauthorized_client")
		return {
			verdict: "rejected",
			error: `Microsoft does not allow this app to sign in here${code ? ` (${code})` : ""}. Check the supported account types.`,
		};
	if (status >= 500 || status === 429) return { verdict: "unverified" };
	return { verdict: "ok" };
}

/** Whether two addresses are the same mailbox (case-insensitive). */
export function sameMailAddress(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}
