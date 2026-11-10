import { missingColumnFromError } from "@/lib/auth/user-lookup-utils";
import { isNoSuchTableError } from "@/lib/modules/state-utils";

/**
 * The OAuth columns and table of migration 0105, read and written with plain SQL: none of them is mapped in Drizzle,
 * so whole-row reads and inserts of `external_accounts` and `app_settings` keep working before the migration runs.
 * Timestamps are seconds, like the Drizzle `timestamp` columns next to them.
 */

type StoreEnv = Pick<CloudflareEnv, "DB">;

const readyDatabases = new WeakSet<object>();

/** Whether migration 0105 has been applied (its table and columns arrive together). */
export async function oauthTablesReady(env: StoreEnv): Promise<boolean> {
	if (readyDatabases.has(env.DB)) return true;
	const row = await env.DB.prepare("SELECT count(*) AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
		.bind("oauth_states")
		.first<{ present: number }>();
	const ready = Number(row?.present ?? 0) === 1;
	if (ready) readyDatabases.add(env.DB);
	return ready;
}

/** A read or write that met the database before migration 0105. */
export function isOAuthMigrationPending(error: unknown): boolean {
	return !!missingColumnFromError(error) || isNoSuchTableError(error);
}

const toSeconds = (date: Date) => Math.floor(date.getTime() / 1000);
const fromSeconds = (value: number | null | undefined) => (value == null ? null : new Date(Number(value) * 1000));

/** The sealed app registration saved in Admin → General, or null; `undefined` before migration 0105. */
export async function readStoredMicrosoftClient(env: StoreEnv): Promise<string | null | undefined> {
	try {
		const row = await env.DB.prepare("SELECT oauth_microsoft_client AS value FROM app_settings WHERE id = ?")
			.bind("default")
			.first<{ value: string | null }>();
		return row?.value ?? null;
	} catch (error) {
		if (isOAuthMigrationPending(error)) return undefined;
		throw error;
	}
}

/** Saves (or, with null, removes) the sealed app registration. Throws before migration 0105. */
export async function writeStoredMicrosoftClient(env: StoreEnv, sealed: string | null, now: Date): Promise<void> {
	await env.DB.prepare(
		"INSERT INTO app_settings (id, oauth_microsoft_client, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET oauth_microsoft_client = excluded.oauth_microsoft_client, updated_at = excluded.updated_at",
	)
		.bind("default", sealed, toSeconds(now))
		.run();
}

/** What a sign-in in progress carries to the callback (`oauth_states.payload`); never a secret. */
export type OAuthStatePayload = {
	mailboxId: string;
	label: string | null;
	displayName: string | null;
	loginHint: string | null;
	syncIntervalMinutes: number | null;
	switches: Record<string, boolean>;
	/** The e2e fakes' servers, accepted only while `EXTERNAL_OAUTH_TEST_ORIGIN` is in effect. */
	testServers: {
		imap: { host: string; port: number; security: "tls" | "starttls" };
		smtp: { host: string; port: number; security: "tls" | "starttls" };
	} | null;
	redirectUri: string;
};

export type OAuthStateRow = {
	userId: string;
	provider: string;
	sealedVerifier: string;
	accountId: string | null;
	payload: OAuthStatePayload;
	expiresAt: Date;
};

export async function insertOAuthState(env: StoreEnv, stateHash: string, row: OAuthStateRow, now: Date): Promise<void> {
	await env.DB.prepare(
		"INSERT INTO oauth_states (state_hash, user_id, provider, code_verifier, account_id, payload, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
	)
		.bind(
			stateHash,
			row.userId,
			row.provider,
			row.sealedVerifier,
			row.accountId,
			JSON.stringify(row.payload),
			toSeconds(row.expiresAt),
			toSeconds(now),
		)
		.run();
}

/**
 * Takes a state out of the table: the row is deleted by the same request that reads it, and only the request whose
 * delete removed it gets it, so a state works once even when the callback is opened twice at the same time.
 */
export async function takeOAuthState(env: StoreEnv, stateHash: string): Promise<OAuthStateRow | null> {
	const row = await env.DB.prepare(
		"SELECT user_id, provider, code_verifier, account_id, payload, expires_at FROM oauth_states WHERE state_hash = ?",
	)
		.bind(stateHash)
		.first<{
			user_id: string;
			provider: string;
			code_verifier: string;
			account_id: string | null;
			payload: string;
			expires_at: number;
		}>();
	if (!row) return null;
	const removed = await env.DB.prepare("DELETE FROM oauth_states WHERE state_hash = ?").bind(stateHash).run();
	if (Number(removed.meta?.changes ?? 0) !== 1) return null;
	let payload: OAuthStatePayload;
	try {
		payload = JSON.parse(row.payload) as OAuthStatePayload;
	} catch {
		return null;
	}
	return {
		userId: row.user_id,
		provider: row.provider,
		sealedVerifier: row.code_verifier,
		accountId: row.account_id,
		payload,
		expiresAt: fromSeconds(row.expires_at)!,
	};
}

/** Removes sign-ins that were never finished. */
export async function pruneOAuthStates(env: StoreEnv, now: Date): Promise<void> {
	await env.DB.prepare("DELETE FROM oauth_states WHERE expires_at < ?").bind(toSeconds(now)).run();
}

/** A user may have a few sign-ins open (several tabs); past this, the oldest are dropped. */
export async function capOAuthStates(env: StoreEnv, userId: string, keep: number): Promise<void> {
	await env.DB.prepare(
		"DELETE FROM oauth_states WHERE user_id = ? AND state_hash NOT IN (SELECT state_hash FROM oauth_states WHERE user_id = ? ORDER BY created_at DESC LIMIT ?)",
	)
		.bind(userId, userId, keep)
		.run();
}

/** An account's token state: the sealed refresh token (`secret`), the cached access token and the CAS version. */
export type TokenState = {
	sealedRefreshToken: string;
	sealedAccessToken: string | null;
	expiresAt: Date | null;
	version: number;
};

export async function readTokenState(env: StoreEnv, accountId: string): Promise<TokenState | null> {
	const row = await env.DB.prepare(
		"SELECT secret, oauth_access_token, oauth_expires_at, oauth_token_version FROM external_accounts WHERE id = ?",
	)
		.bind(accountId)
		.first<{
			secret: string;
			oauth_access_token: string | null;
			oauth_expires_at: number | null;
			oauth_token_version: number;
		}>();
	if (!row) return null;
	return {
		sealedRefreshToken: row.secret ?? "",
		sealedAccessToken: row.oauth_access_token,
		expiresAt: fromSeconds(row.oauth_expires_at),
		version: Number(row.oauth_token_version ?? 0),
	};
}

export type TokenWrite = {
	/** A new sealed refresh token (Microsoft rotates it on each refresh); null keeps the stored one. */
	sealedRefreshToken: string | null;
	sealedAccessToken: string;
	expiresAt: Date;
	scopes: string;
};

/**
 * Stores refreshed tokens only while the account's version is still `expectedVersion`, bumping it (spec §15.3): of two
 * refreshes at once, one stores and the other learns it lost. A refresh token that changed meanwhile (a reconnect)
 * is never overwritten with an older one.
 */
export async function storeRefreshedTokens(
	env: StoreEnv,
	accountId: string,
	expectedVersion: number,
	tokens: TokenWrite,
	now: Date,
): Promise<boolean> {
	const result = await env.DB.prepare(
		"UPDATE external_accounts SET secret = COALESCE(?, secret), oauth_access_token = ?, oauth_expires_at = ?, oauth_scopes = ?, oauth_token_version = oauth_token_version + 1, updated_at = ? WHERE id = ? AND oauth_token_version = ? AND secret <> ''",
	)
		.bind(
			tokens.sealedRefreshToken,
			tokens.sealedAccessToken,
			toSeconds(tokens.expiresAt),
			tokens.scopes,
			toSeconds(now),
			accountId,
			expectedVersion,
		)
		.run();
	return Number(result.meta?.changes ?? 0) === 1;
}

/** The OAuth columns of a connect or reconnect, written after the row's own columns; bumps the version. */
export async function writeAccountOAuth(
	env: StoreEnv,
	accountId: string,
	values: { sealedAccessToken: string; expiresAt: Date; scopes: string; subject: string },
): Promise<void> {
	await env.DB.prepare(
		"UPDATE external_accounts SET oauth_access_token = ?, oauth_expires_at = ?, oauth_scopes = ?, oauth_subject = ?, oauth_token_version = oauth_token_version + 1 WHERE id = ?",
	)
		.bind(values.sealedAccessToken, toSeconds(values.expiresAt), values.scopes, values.subject, accountId)
		.run();
}

/** Forgets a cached access token, so the next use refreshes (a server refused it). */
export async function expireAccessToken(env: StoreEnv, accountId: string): Promise<void> {
	await env.DB.prepare("UPDATE external_accounts SET oauth_expires_at = 0 WHERE id = ?").bind(accountId).run();
}

/** Forgets an account's OAuth state when it switches to a password (an edit to another provider). */
export async function clearAccountOAuth(env: StoreEnv, accountId: string): Promise<void> {
	try {
		await env.DB.prepare(
			"UPDATE external_accounts SET oauth_access_token = NULL, oauth_expires_at = NULL, oauth_scopes = NULL, oauth_subject = NULL, oauth_token_version = oauth_token_version + 1 WHERE id = ?",
		)
			.bind(accountId)
			.run();
	} catch (error) {
		if (!isOAuthMigrationPending(error)) throw error;
	}
}

/** Erases the cached access tokens of accounts whose credential was erased (retention). */
export async function eraseOrphanAccessTokens(env: StoreEnv): Promise<void> {
	try {
		await env.DB.prepare(
			"UPDATE external_accounts SET oauth_access_token = NULL, oauth_expires_at = NULL WHERE secret = '' AND oauth_access_token IS NOT NULL",
		).run();
	} catch (error) {
		if (!isOAuthMigrationPending(error)) throw error;
	}
}
