import { createLogger } from "@/lib/logger.mjs";
import { openSetting, SecretBoxError, sealSetting } from "@/lib/security/secret-box";
import { type OAuthApp, resolveOAuthApp } from "./oauth-app";
import { type ClientEnv, TOKEN_REQUEST_TIMEOUT_MS } from "./oauth-client";
import { OAUTH_PROVIDERS, oauthProviderOf } from "./oauth-provider-utils";
import { readTokenState, storeRefreshedTokens, type TokenState } from "./oauth-store";
import {
	needsRefresh,
	type OAuthTokens,
	OAuthTokenError,
	parseTokenResponse,
	tokenFailure,
	type TokenGrant,
} from "./oauth-utils";

const logger = createLogger("external");

/**
 * An account's credential cannot be used now: `auth` needs the owner to reconnect (the account goes to Sign-in
 * failed), `transient` is worth trying again later. The message is safe to show and store.
 */
export class CredentialUnavailableError extends Error {
	constructor(
		readonly kind: "auth" | "transient",
		message: string,
	) {
		super(message);
		this.name = "CredentialUnavailableError";
	}
}

type TokenEnv = ClientEnv;

/** One request to the provider's token endpoint; its failures are `OAuthTokenError`s and never contain a token. */
async function tokenRequest(app: OAuthApp, grant: TokenGrant, fetcher: typeof fetch = fetch): Promise<OAuthTokens> {
	const label = app.provider.label;
	let response: Response;
	try {
		response = await fetcher(app.endpoints.token, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
			body: app.tokenBody(grant),
			redirect: "manual",
			signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
		});
	} catch {
		throw new OAuthTokenError("transient", `${label} could not be reached. Kite tries again later.`);
	}
	const body = await response.json().catch(() => null);
	if (!response.ok) throw tokenFailure(response.status, body, label);
	return parseTokenResponse(body, new Date(), label);
}

/** Redeems the code the callback received, with the PKCE verifier of its state (spec §15.2). */
export function exchangeAuthorizationCode(
	app: OAuthApp,
	input: { code: string; verifier: string; redirectUri: string },
	fetcher?: typeof fetch,
): Promise<OAuthTokens> {
	return tokenRequest(app, { kind: "authorization_code", ...input }, fetcher);
}

async function openCachedAccessToken(env: TokenEnv, state: TokenState): Promise<string | null> {
	if (!state.sealedAccessToken) return null;
	try {
		return await openSetting(env, state.sealedAccessToken);
	} catch (error) {
		if (error instanceof SecretBoxError) return null;
		throw error;
	}
}

/**
 * The access token of an OAuth account (spec §15.3): the cached one until 5 minutes before it expires, else a new one
 * from the sealed refresh token. `forceRefresh` skips the cache (a server refused the cached token). Of two refreshes
 * at once only one stores its tokens (compare-and-swap on `oauth_token_version`); the other uses what was stored, or
 * its own access token, which is just as valid.
 */
export async function oauthAccessToken(
	env: TokenEnv,
	accountId: string,
	options: { forceRefresh?: boolean; now?: Date; fetcher?: typeof fetch } = {},
): Promise<string> {
	const now = options.now ?? new Date();
	const state = await readTokenState(env, accountId);
	if (!state?.sealedRefreshToken) {
		const label = OAUTH_PROVIDERS[oauthProviderOf(state?.authKind ?? "") ?? "microsoft"].label;
		throw new CredentialUnavailableError("auth", `The ${label} sign-in is no longer saved. Reconnect the account.`);
	}
	if (!options.forceRefresh && !needsRefresh(state.expiresAt, now, !!state.sealedAccessToken)) {
		const cached = await openCachedAccessToken(env, state);
		if (cached) return cached;
	}
	return refreshAccessToken(env, accountId, state, now, options.fetcher);
}

async function refreshAccessToken(
	env: TokenEnv,
	accountId: string,
	state: TokenState,
	now: Date,
	fetcher?: typeof fetch,
): Promise<string> {
	const provider = oauthProviderOf(state.authKind);
	if (!provider)
		throw new CredentialUnavailableError("auth", "The account no longer signs in with a provider. Reconnect it.");
	const label = OAUTH_PROVIDERS[provider].label;
	const app = await resolveOAuthApp(env, provider);
	if (!app)
		throw new CredentialUnavailableError(
			"auth",
			`${label} sign-in is no longer set up on this Kite. Ask your admin, then reconnect the account.`,
		);
	let refreshToken: string | null;
	try {
		refreshToken = await openSetting(env, state.sealedRefreshToken);
	} catch (error) {
		if (!(error instanceof SecretBoxError)) throw error;
		refreshToken = null;
	}
	if (!refreshToken)
		throw new CredentialUnavailableError(
			"auth",
			`The saved ${label} sign-in can no longer be opened. Reconnect the account.`,
		);
	let tokens: OAuthTokens;
	try {
		tokens = await tokenRequest(app, { kind: "refresh_token", refreshToken }, fetcher);
	} catch (error) {
		if (!(error instanceof OAuthTokenError)) throw error;
		logger.warn("external.oauth.refresh_failed", { accountId, provider, kind: error.kind, code: error.code });
		// Only a revoked or expired sign-in needs the user. A refused app registration is the owner's to fix (an expired
		// client secret), so the account keeps retrying with backoff and recovers on its own once it is fixed.
		throw new CredentialUnavailableError(error.kind === "reauth" ? "auth" : "transient", error.message);
	}
	const stored = await storeRefreshedTokens(
		env,
		accountId,
		state.version,
		{
			sealedRefreshToken: tokens.refreshToken ? await sealSetting(env, tokens.refreshToken) : null,
			sealedAccessToken: await sealSetting(env, tokens.accessToken),
			expiresAt: tokens.expiresAt,
			scopes: tokens.scopes,
		},
		now,
	);
	if (stored) {
		logger.info("external.oauth.refreshed", { accountId, provider });
		return tokens.accessToken;
	}
	// Another refresh stored first; its token is the one the account keeps, and this one stays valid meanwhile.
	const latest = await readTokenState(env, accountId);
	const cached = latest && !needsRefresh(latest.expiresAt, now, true) ? await openCachedAccessToken(env, latest) : null;
	return cached ?? tokens.accessToken;
}
