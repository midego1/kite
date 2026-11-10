import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { newId } from "@/lib/ids";
import { createLogger } from "@/lib/logger.mjs";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import {
	countUnusedClients,
	deleteGrant,
	deleteUnusedClients,
	deleteToken,
	grantOfUsedCode,
	insertClient,
	insertCode,
	insertGrant,
	listGrantIds,
	pruneMcpOAuthRows,
	readClient,
	readToken,
	rotateRefreshToken,
	takeCode,
	toSeconds,
	type TokenRow,
	isMcpOAuthPending,
} from "./store";
import {
	clientNetwork,
	hashOAuthToken,
	openSuccessor,
	OAuthError,
	OAUTH_ACCESS_TOKEN_PREFIX,
	OAUTH_ACCESS_TOKEN_TTL_SECONDS,
	OAUTH_CLIENT_ID_PREFIX,
	OAUTH_CODE_TTL_SECONDS,
	OAUTH_IDLE_CLIENT_TTL_SECONDS,
	OAUTH_MAX_GRANTS_PER_USER,
	OAUTH_MAX_UNUSED_CLIENTS,
	OAUTH_MAX_UNUSED_CLIENTS_PER_NETWORK,
	OAUTH_REFRESH_GRACE_SECONDS,
	OAUTH_REFRESH_TOKEN_PREFIX,
	OAUTH_REFRESH_TOKEN_TTL_SECONDS,
	OAUTH_UNUSED_CLIENT_TTL_SECONDS,
	randomOAuthToken,
	resourceMatches,
	sealSuccessor,
	tokenResponse,
	verifyPkce,
	type ClientRegistration,
	type OAuthClient,
} from "./utils";

const log = createLogger("mcp.oauth");

/**
 * Registers a public client (RFC 7591) for a request from `ip`. Registrations unused for an hour are removed first;
 * new ones are refused while too many recent ones are still unused, in all or from the same /24 (IPv6 /48).
 */
export async function registerClient(
	env: CloudflareEnv,
	registration: ClientRegistration,
	now: Date,
	ip: string | null = null,
): Promise<OAuthClient> {
	const since = toSeconds(now) - OAUTH_UNUSED_CLIENT_TTL_SECONDS;
	await deleteUnusedClients(env, since);
	const network = await hashOAuthToken(clientNetwork(ip));
	const unused = await countUnusedClients(env, since, network);
	if (unused.total >= OAUTH_MAX_UNUSED_CLIENTS || unused.network >= OAUTH_MAX_UNUSED_CLIENTS_PER_NETWORK)
		throw new OAuthError("temporarily_unavailable", "Too many registrations; try again in an hour", 429);
	const client = { id: `${OAUTH_CLIENT_ID_PREFIX}${randomOAuthToken().slice(0, 32)}`, ...registration };
	await insertClient(env, client, network, now);
	log.info("mcp.oauth.client_registered", { clientId: client.id });
	return client;
}

export function findClient(env: CloudflareEnv, clientId: string | null | undefined): Promise<OAuthClient | null> {
	if (!clientId || clientId.length > 64) return Promise.resolve(null);
	return readClient(env, clientId);
}

export type ApprovedAuthorization = {
	clientId: string;
	userId: string;
	redirectUri: string;
	redirectUriSent: boolean;
	codeChallenge: string;
	resource: string;
	scopes: string[];
	mailboxIds: string[];
};

/** The code a consent returns to the client; only its hash is stored. */
export async function createAuthorizationCode(
	env: CloudflareEnv,
	approved: ApprovedAuthorization,
	now: Date,
): Promise<string> {
	const code = randomOAuthToken();
	await insertCode(
		env,
		await hashOAuthToken(code),
		{ ...approved, expiresAt: toSeconds(now) + OAUTH_CODE_TTL_SECONDS },
		now,
	);
	return code;
}

type TokenPair = { accessToken: string; refreshToken: string; accessHash: string; refreshHash: string };

async function newTokenPair(): Promise<TokenPair> {
	const accessToken = randomOAuthToken(OAUTH_ACCESS_TOKEN_PREFIX);
	const refreshToken = randomOAuthToken(OAUTH_REFRESH_TOKEN_PREFIX);
	return {
		accessToken,
		refreshToken,
		accessHash: await hashOAuthToken(accessToken),
		refreshHash: await hashOAuthToken(refreshToken),
	};
}

const invalidGrant = (description = "The code or token is invalid, expired or was already used") =>
	new OAuthError("invalid_grant", description);

async function activeUser(env: CloudflareEnv, userId: string) {
	const [user] = await getDb(env).select().from(users).where(eq(users.id, userId)).limit(1);
	return user && !user.disabled ? user : null;
}

/** The mailboxes of a grant that its user can still read; the MCP route checks again on every request. */
async function readableMailboxes(env: CloudflareEnv, userId: string, mailboxIds: readonly string[]) {
	const user = await activeUser(env, userId);
	if (!user) return null;
	const db = getDb(env);
	const readable: string[] = [];
	for (const mailboxId of mailboxIds)
		if ((await getMailboxAccessLevel(db, user, mailboxId))?.canRead) readable.push(mailboxId);
	return readable;
}

export type CodeExchange = {
	clientId: string | null;
	code: string | null;
	redirectUri: string | null;
	codeVerifier: string | null;
	resource: string | null;
};

/**
 * Redeems an authorization code (OAuth 2.1 §4.1.3): single use, unexpired, the same client, the PKCE verifier, the
 * same redirect URI when the authorization request named one (and none when it did not) and, when named, the same
 * resource. A code presented a second time revokes what the first use got.
 */
export async function exchangeAuthorizationCode(env: CloudflareEnv, input: CodeExchange, now: Date) {
	if (!input.code || !input.clientId) throw new OAuthError("invalid_request", "code and client_id are required");
	const codeHash = await hashOAuthToken(input.code);
	const code = await takeCode(env, codeHash, now);
	if (!code) {
		const replayed = await grantOfUsedCode(env, codeHash);
		if (replayed) {
			await deleteGrant(env, replayed);
			log.warn("mcp.oauth.code_replayed", { keyId: replayed });
		}
		throw invalidGrant();
	}
	const redirectMatches = code.redirectUriSent
		? input.redirectUri === code.redirectUri
		: input.redirectUri === null || input.redirectUri === code.redirectUri;
	if (code.expiresAt < toSeconds(now) || code.clientId !== input.clientId || !redirectMatches) throw invalidGrant();
	if (!(await verifyPkce(input.codeVerifier, code.codeChallenge))) throw invalidGrant("PKCE verification failed");
	if (!resourceMatches(input.resource, code.resource))
		throw new OAuthError("invalid_target", "resource does not match the authorization request");
	const client = await readClient(env, code.clientId);
	if (!client) throw new OAuthError("invalid_client", "Unknown client", 401);
	const mailboxIds = await readableMailboxes(env, code.userId, code.mailboxIds);
	if (!mailboxIds) throw invalidGrant();
	// A client connecting again replaces its earlier grant for this user.
	const earlier = await listGrantIds(env, code.userId, client.id);
	const tokens = await newTokenPair();
	const keyId = newId("key");
	const at = toSeconds(now);
	await insertGrant(
		env,
		{
			keyId,
			clientId: client.id,
			clientName: client.name,
			userId: code.userId,
			redirectUri: code.redirectUri,
			resource: code.resource,
			scopes: code.scopes,
			mailboxIds,
			codeHash,
			accessHash: tokens.accessHash,
			refreshHash: tokens.refreshHash,
			accessExpiresAt: at + OAUTH_ACCESS_TOKEN_TTL_SECONDS,
			refreshExpiresAt: at + OAUTH_REFRESH_TOKEN_TTL_SECONDS,
		},
		now,
	);
	for (const id of earlier) await deleteGrant(env, id);
	for (const id of (await listGrantIds(env, code.userId)).slice(OAUTH_MAX_GRANTS_PER_USER)) await deleteGrant(env, id);
	log.info("mcp.oauth.grant_created", { keyId, clientId: client.id });
	return tokenResponse(tokens.accessToken, tokens.refreshToken, code.scopes);
}

export type RefreshRequest = {
	clientId: string | null;
	refreshToken: string | null;
	resource: string | null;
	scope: string | null;
};

/**
 * A rotated refresh token presented again. Within `OAUTH_REFRESH_GRACE_SECONDS`, while the pair it was rotated for is
 * still the grant's current one, it gets that same pair: a client refreshing from two processes at once is not theft.
 * Otherwise it is treated as stolen and the whole grant is revoked (RFC 9700 §4.14.2).
 */
async function replayedRefresh(env: CloudflareEnv, token: TokenRow, presented: string, now: Date) {
	const at = toSeconds(now);
	const pair =
		token.rotatedAt !== null && at - token.rotatedAt <= OAUTH_REFRESH_GRACE_SECONDS && token.successor
			? await openSuccessor(presented, token.successor)
			: null;
	const current = pair ? await readToken(env, await hashOAuthToken(pair.refreshToken)) : null;
	if (pair && current && current.rotatedAt === null && pair.accessExpiresAt > at) {
		if (!(await activeUser(env, token.userId))) throw invalidGrant();
		return tokenResponse(pair.accessToken, pair.refreshToken, token.scopes, pair.accessExpiresAt - at);
	}
	await deleteGrant(env, token.keyId);
	log.warn("mcp.oauth.refresh_replayed", { keyId: token.keyId });
	throw invalidGrant();
}

/**
 * Exchanges a refresh token for a new pair (OAuth 2.1 §4.3, rotation per §4.3.1). The used token stays stored until it
 * expires so that presenting it again is recognised: within a minute it gets the same new pair, later the whole grant
 * is revoked (`replayedRefresh`).
 */
export async function refreshTokens(env: CloudflareEnv, input: RefreshRequest, now: Date) {
	if (!input.refreshToken || !input.clientId)
		throw new OAuthError("invalid_request", "refresh_token and client_id are required");
	const tokenHash = await hashOAuthToken(input.refreshToken);
	const token = await readToken(env, tokenHash);
	if (!token || token.kind !== "refresh" || token.clientId !== input.clientId) throw invalidGrant();
	if (!resourceMatches(input.resource, token.resource))
		throw new OAuthError("invalid_target", "resource does not match the grant");
	const asked = input.scope?.split(" ").filter(Boolean) ?? [];
	if (asked.some((scope) => !token.scopes.includes(scope)))
		throw new OAuthError("invalid_scope", "A refresh cannot add scopes");
	if (token.rotatedAt !== null) return replayedRefresh(env, token, input.refreshToken, now);
	if (token.expiresAt < toSeconds(now)) throw invalidGrant();
	if (!(await activeUser(env, token.userId))) throw invalidGrant();
	const tokens = await newTokenPair();
	const at = toSeconds(now);
	const accessExpiresAt = at + OAUTH_ACCESS_TOKEN_TTL_SECONDS;
	const sealed = await sealSuccessor(input.refreshToken, {
		accessToken: tokens.accessToken,
		refreshToken: tokens.refreshToken,
		accessExpiresAt,
	});
	const rotated = await rotateRefreshToken(
		env,
		tokenHash,
		token.keyId,
		sealed,
		{
			accessHash: tokens.accessHash,
			refreshHash: tokens.refreshHash,
			accessExpiresAt,
			refreshExpiresAt: at + OAUTH_REFRESH_TOKEN_TTL_SECONDS,
		},
		now,
	);
	if (rotated) return tokenResponse(tokens.accessToken, tokens.refreshToken, token.scopes);
	// Another refresh with the same token got there first: this one gets the pair that refresh stored.
	const winner = await readToken(env, tokenHash);
	if (!winner) throw invalidGrant();
	return replayedRefresh(env, winner, input.refreshToken, now);
}

/**
 * Token revocation (RFC 7009). A refresh token revokes its whole grant, an access token only itself. The client must
 * name itself and own the token; an unknown token is not an error (§2.2).
 */
export async function revokeToken(env: CloudflareEnv, token: string, clientId: string): Promise<void> {
	const tokenHash = await hashOAuthToken(token);
	const row = await readToken(env, tokenHash);
	if (!row || row.clientId !== clientId) return;
	if (row.kind === "refresh") await deleteGrant(env, row.keyId);
	else await deleteToken(env, tokenHash);
}

/** The grant (its `api_keys` id) an access token stands for, when it is live and bound to `resource`. */
export async function grantOfAccessToken(env: CloudflareEnv, token: string, resource: string): Promise<string | null> {
	if (!token.startsWith(OAUTH_ACCESS_TOKEN_PREFIX) || token.length > 128) return null;
	try {
		const row = await readToken(env, await hashOAuthToken(token));
		if (!row || row.kind !== "access" || row.expiresAt < toSeconds(new Date())) return null;
		// RFC 8707: a token is only good for the resource it was issued for.
		return row.resource === resource ? row.keyId : null;
	} catch (error) {
		if (isMcpOAuthPending(error)) return null;
		throw error;
	}
}

/** The daily clean-up; does nothing before migration 0106. */
export async function pruneMcpOAuth(env: CloudflareEnv, now: Date): Promise<number> {
	try {
		return await pruneMcpOAuthRows(
			env,
			now,
			OAUTH_UNUSED_CLIENT_TTL_SECONDS,
			OAUTH_IDLE_CLIENT_TTL_SECONDS,
			OAUTH_REFRESH_GRACE_SECONDS,
		);
	} catch (error) {
		if (isMcpOAuthPending(error)) return 0;
		throw error;
	}
}
