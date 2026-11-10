import { isNoSuchTableError } from "@/lib/modules/state-utils";
import type { OAuthClient } from "./utils";

/**
 * The tables of migration 0106, read and written with plain SQL like `oauth_states`: none is mapped in Drizzle, so
 * nothing else changes before the migration runs. Timestamps are seconds, like the Drizzle `timestamp` columns.
 */

type StoreEnv = Pick<CloudflareEnv, "DB">;

export const isMcpOAuthPending = isNoSuchTableError;

export const toSeconds = (date: Date) => Math.floor(date.getTime() / 1000);

function parseList(value: string | null | undefined): string[] {
	try {
		const parsed = JSON.parse(value ?? "[]") as unknown;
		return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
	} catch {
		return [];
	}
}

/** Unused registrations made since `since` (seconds), in all and from one network (its hash). */
export async function countUnusedClients(
	env: StoreEnv,
	since: number,
	network: string,
): Promise<{ total: number; network: number }> {
	const row = await env.DB.prepare(
		"SELECT count(*) AS total, coalesce(sum(network = ?), 0) AS from_network FROM mcp_oauth_clients WHERE last_used_at IS NULL AND created_at >= ?",
	)
		.bind(network, since)
		.first<{ total: number; from_network: number }>();
	return { total: Number(row?.total ?? 0), network: Number(row?.from_network ?? 0) };
}

/** Removes registrations never used for a grant and made before `before` (seconds). */
export async function deleteUnusedClients(env: StoreEnv, before: number): Promise<void> {
	await env.DB.prepare(
		"DELETE FROM mcp_oauth_clients WHERE last_used_at IS NULL AND created_at < ? AND NOT EXISTS (SELECT 1 FROM mcp_oauth_grants g WHERE g.client_id = mcp_oauth_clients.id)",
	)
		.bind(before)
		.run();
}

export async function insertClient(env: StoreEnv, client: OAuthClient, network: string, now: Date): Promise<void> {
	await env.DB.prepare(
		"INSERT INTO mcp_oauth_clients (id, name, redirect_uris, network, created_at) VALUES (?, ?, ?, ?, ?)",
	)
		.bind(client.id, client.name, JSON.stringify(client.redirectUris), network, toSeconds(now))
		.run();
}

export async function readClient(env: StoreEnv, clientId: string): Promise<OAuthClient | null> {
	const row = await env.DB.prepare("SELECT id, name, redirect_uris FROM mcp_oauth_clients WHERE id = ?")
		.bind(clientId)
		.first<{ id: string; name: string; redirect_uris: string }>();
	return row ? { id: row.id, name: row.name, redirectUris: parseList(row.redirect_uris) } : null;
}

export type CodeRow = {
	clientId: string;
	userId: string;
	redirectUri: string;
	/** Whether the authorization request named the redirect URI; the token request must then repeat it. */
	redirectUriSent: boolean;
	codeChallenge: string;
	resource: string;
	scopes: string[];
	mailboxIds: string[];
	expiresAt: number;
};

export async function insertCode(env: StoreEnv, codeHash: string, code: CodeRow, now: Date): Promise<void> {
	await env.DB.prepare(
		"INSERT INTO mcp_oauth_codes (code_hash, client_id, user_id, redirect_uri, redirect_uri_sent, code_challenge, resource, scopes, mailbox_ids, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	)
		.bind(
			codeHash,
			code.clientId,
			code.userId,
			code.redirectUri,
			code.redirectUriSent ? 1 : 0,
			code.codeChallenge,
			code.resource,
			JSON.stringify(code.scopes),
			JSON.stringify(code.mailboxIds),
			code.expiresAt,
			toSeconds(now),
		)
		.run();
}

type RawCode = {
	client_id: string;
	user_id: string;
	redirect_uri: string;
	redirect_uri_sent: number;
	code_challenge: string;
	resource: string;
	scopes: string;
	mailbox_ids: string;
	expires_at: number;
};

/**
 * Marks a code used and returns it, or null when it is unknown or was used before. Only the request whose update
 * changed the row gets it, so a code works once even when two token requests race.
 */
export async function takeCode(env: StoreEnv, codeHash: string, now: Date): Promise<CodeRow | null> {
	const row = await env.DB.prepare(
		"UPDATE mcp_oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL RETURNING client_id, user_id, redirect_uri, redirect_uri_sent, code_challenge, resource, scopes, mailbox_ids, expires_at",
	)
		.bind(toSeconds(now), codeHash)
		.first<RawCode>();
	if (!row) return null;
	return {
		clientId: row.client_id,
		userId: row.user_id,
		redirectUri: row.redirect_uri,
		redirectUriSent: Number(row.redirect_uri_sent) !== 0,
		codeChallenge: row.code_challenge,
		resource: row.resource,
		scopes: parseList(row.scopes),
		mailboxIds: parseList(row.mailbox_ids),
		expiresAt: Number(row.expires_at),
	};
}

/** The grant a used code was redeemed for, so a replayed code can revoke it (RFC 6749 §4.1.2); null if none. */
export async function grantOfUsedCode(env: StoreEnv, codeHash: string): Promise<string | null> {
	const row = await env.DB.prepare("SELECT key_id FROM mcp_oauth_codes WHERE code_hash = ? AND used_at IS NOT NULL")
		.bind(codeHash)
		.first<{ key_id: string | null }>();
	return row?.key_id ?? null;
}

export type NewGrant = {
	keyId: string;
	clientId: string;
	clientName: string;
	userId: string;
	redirectUri: string;
	resource: string;
	scopes: string[];
	mailboxIds: string[];
	codeHash: string;
	accessHash: string;
	refreshHash: string;
	accessExpiresAt: number;
	refreshExpiresAt: number;
};

const INSERT_TOKEN =
	"INSERT INTO mcp_oauth_tokens (token_hash, key_id, kind, expires_at, created_at) VALUES (?, ?, ?, ?, ?)";

/**
 * Creates a grant in one batch: the `api_keys` row of kind `oauth` (its hash `!` is no bcrypt hash, so no key ever
 * matches it, and its prefix never equals the first 12 characters of a key), its mailboxes, the grant, both tokens,
 * and the code's link to it.
 */
export async function insertGrant(env: StoreEnv, grant: NewGrant, now: Date): Promise<void> {
	const at = toSeconds(now);
	const db = env.DB;
	await db.batch([
		db
			.prepare(
				"INSERT INTO api_keys (id, kind, user_id, name, prefix, key_hash, scopes, mailbox_scope_enabled, created_at) VALUES (?, 'oauth', ?, ?, 'oauth', '!', ?, 1, ?)",
			)
			.bind(grant.keyId, grant.userId, grant.clientName, JSON.stringify(grant.scopes), at),
		...grant.mailboxIds.map((mailboxId) =>
			db.prepare("INSERT INTO mcp_key_mailboxes (key_id, mailbox_id) VALUES (?, ?)").bind(grant.keyId, mailboxId),
		),
		db
			.prepare(
				"INSERT INTO mcp_oauth_grants (key_id, client_id, user_id, redirect_uri, resource, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.bind(grant.keyId, grant.clientId, grant.userId, grant.redirectUri, grant.resource, at),
		db.prepare(INSERT_TOKEN).bind(grant.accessHash, grant.keyId, "access", grant.accessExpiresAt, at),
		db.prepare(INSERT_TOKEN).bind(grant.refreshHash, grant.keyId, "refresh", grant.refreshExpiresAt, at),
		db.prepare("UPDATE mcp_oauth_codes SET key_id = ? WHERE code_hash = ?").bind(grant.keyId, grant.codeHash),
		db.prepare("UPDATE mcp_oauth_clients SET last_used_at = ? WHERE id = ?").bind(at, grant.clientId),
	]);
}

export type TokenRow = {
	keyId: string;
	kind: "access" | "refresh";
	expiresAt: number;
	rotatedAt: number | null;
	/** The sealed pair a rotation issued (`sealSuccessor`), for the grace window. */
	successor: string | null;
	clientId: string;
	userId: string;
	resource: string;
	scopes: string[];
};

/** A token by its hash, with its grant, or null. */
export async function readToken(env: StoreEnv, tokenHash: string): Promise<TokenRow | null> {
	const row = await env.DB.prepare(
		"SELECT t.key_id, t.kind, t.expires_at, t.rotated_at, t.successor, g.client_id, g.user_id, g.resource, k.scopes FROM mcp_oauth_tokens t JOIN mcp_oauth_grants g ON g.key_id = t.key_id JOIN api_keys k ON k.id = t.key_id WHERE t.token_hash = ?",
	)
		.bind(tokenHash)
		.first<{
			key_id: string;
			kind: string;
			expires_at: number;
			rotated_at: number | null;
			successor: string | null;
			client_id: string;
			user_id: string;
			resource: string;
			scopes: string;
		}>();
	if (!row || (row.kind !== "access" && row.kind !== "refresh")) return null;
	return {
		keyId: row.key_id,
		kind: row.kind,
		expiresAt: Number(row.expires_at),
		rotatedAt: row.rotated_at == null ? null : Number(row.rotated_at),
		successor: row.successor ?? null,
		clientId: row.client_id,
		userId: row.user_id,
		resource: row.resource,
		scopes: parseList(row.scopes),
	};
}

/**
 * A refresh in one transaction: the refresh token is retired with its sealed successor, and only when that update
 * changed it are the new pair stored and the grant's earlier access tokens removed (each later statement checks for
 * this request's own `sealed` value). A failure leaves the old token usable; losing a race to another refresh stores
 * nothing. True when this request rotated the token.
 */
export async function rotateRefreshToken(
	env: StoreEnv,
	refreshHash: string,
	keyId: string,
	sealed: string,
	tokens: { accessHash: string; refreshHash: string; accessExpiresAt: number; refreshExpiresAt: number },
	now: Date,
): Promise<boolean> {
	const at = toSeconds(now);
	const db = env.DB;
	const won = "EXISTS (SELECT 1 FROM mcp_oauth_tokens WHERE token_hash = ? AND successor = ?)";
	const insert = `INSERT INTO mcp_oauth_tokens (token_hash, key_id, kind, expires_at, created_at) SELECT ?, ?, ?, ?, ? WHERE ${won}`;
	await db.batch([
		db
			.prepare(
				"UPDATE mcp_oauth_tokens SET rotated_at = ?, successor = ? WHERE token_hash = ? AND kind = 'refresh' AND rotated_at IS NULL",
			)
			.bind(at, sealed, refreshHash),
		db
			.prepare(`DELETE FROM mcp_oauth_tokens WHERE key_id = ? AND kind = 'access' AND ${won}`)
			.bind(keyId, refreshHash, sealed),
		db.prepare(insert).bind(tokens.accessHash, keyId, "access", tokens.accessExpiresAt, at, refreshHash, sealed),
		db.prepare(insert).bind(tokens.refreshHash, keyId, "refresh", tokens.refreshExpiresAt, at, refreshHash, sealed),
		// A client that keeps refreshing is in use, so the pruning keeps its registration.
		db
			.prepare(
				"UPDATE mcp_oauth_clients SET last_used_at = ? WHERE id = (SELECT client_id FROM mcp_oauth_grants WHERE key_id = ?)",
			)
			.bind(at, keyId),
	]);
	const row = await db
		.prepare("SELECT successor FROM mcp_oauth_tokens WHERE token_hash = ?")
		.bind(refreshHash)
		.first<{ successor: string | null }>();
	return row?.successor === sealed;
}

export async function deleteToken(env: StoreEnv, tokenHash: string): Promise<void> {
	await env.DB.prepare("DELETE FROM mcp_oauth_tokens WHERE token_hash = ?").bind(tokenHash).run();
}

/**
 * Revokes a grant: send requests it left pending are cancelled, as when an MCP key is revoked, and its `api_keys`
 * row goes with its tokens, grant and mailboxes (deleted explicitly too, should foreign keys be off).
 */
export async function deleteGrant(env: StoreEnv, keyId: string): Promise<void> {
	const db = env.DB;
	await db.batch([
		db
			.prepare("UPDATE agent_send_approvals SET status = 'cancelled' WHERE request_key_id = ? AND status = 'pending'")
			.bind(keyId),
		db.prepare("DELETE FROM mcp_oauth_tokens WHERE key_id = ?").bind(keyId),
		db.prepare("DELETE FROM mcp_oauth_grants WHERE key_id = ?").bind(keyId),
		db.prepare("DELETE FROM mcp_key_mailboxes WHERE key_id = ?").bind(keyId),
		db.prepare("DELETE FROM api_keys WHERE id = ? AND kind = 'oauth'").bind(keyId),
	]);
}

/** The grants of one user, newest first; with `clientId`, only that client's. */
export async function listGrantIds(env: StoreEnv, userId: string, clientId?: string): Promise<string[]> {
	const statement = clientId
		? env.DB.prepare(
				"SELECT key_id FROM mcp_oauth_grants WHERE user_id = ? AND client_id = ? ORDER BY created_at DESC, rowid DESC",
			).bind(userId, clientId)
		: env.DB.prepare("SELECT key_id FROM mcp_oauth_grants WHERE user_id = ? ORDER BY created_at DESC, rowid DESC").bind(
				userId,
			);
	const { results } = await statement.all<{ key_id: string }>();
	return results.map((row) => row.key_id);
}

export type GrantListRow = {
	id: string;
	clientName: string;
	redirectUri: string;
	scopes: string[];
	mailboxIds: string[];
	createdAt: number;
	lastUsedAt: number | null;
};

export async function listGrants(env: StoreEnv, userId: string): Promise<GrantListRow[]> {
	const { results } = await env.DB.prepare(
		"SELECT g.key_id, g.redirect_uri, g.created_at, c.name, k.scopes, k.last_used_at, (SELECT json_group_array(m.mailbox_id) FROM mcp_key_mailboxes m WHERE m.key_id = g.key_id) AS mailbox_ids FROM mcp_oauth_grants g JOIN mcp_oauth_clients c ON c.id = g.client_id JOIN api_keys k ON k.id = g.key_id WHERE g.user_id = ? ORDER BY g.created_at DESC, g.rowid DESC",
	)
		.bind(userId)
		.all<{
			key_id: string;
			redirect_uri: string;
			created_at: number;
			name: string;
			scopes: string;
			last_used_at: number | null;
			mailbox_ids: string | null;
		}>();
	return results.map((row) => ({
		id: row.key_id,
		clientName: row.name,
		redirectUri: row.redirect_uri,
		scopes: parseList(row.scopes),
		mailboxIds: parseList(row.mailbox_ids),
		createdAt: Number(row.created_at),
		lastUsedAt: row.last_used_at == null ? null : Number(row.last_used_at),
	}));
}

/** One user's grant by id, or false. */
export async function ownsGrant(env: StoreEnv, userId: string, keyId: string): Promise<boolean> {
	const row = await env.DB.prepare("SELECT 1 AS found FROM mcp_oauth_grants WHERE key_id = ? AND user_id = ?")
		.bind(keyId, userId)
		.first<{ found: number }>();
	return !!row;
}

const PRUNE_BATCH = 200;

/**
 * The daily clean-up: expired codes (kept a day after use so a replay still finds them) and tokens, grants left
 * without a live refresh token, `oauth` keys without a grant (a restore brings those back alone), and registrations
 * nobody uses. Returns how many grants it revoked.
 */
export async function pruneMcpOAuthRows(
	env: StoreEnv,
	now: Date,
	unusedClientTtlSeconds: number,
	idleClientTtlSeconds: number,
	graceSeconds: number,
): Promise<number> {
	const at = toSeconds(now);
	const db = env.DB;
	await db.batch([
		db.prepare("DELETE FROM mcp_oauth_codes WHERE expires_at < ?").bind(at - 24 * 60 * 60),
		db.prepare("DELETE FROM mcp_oauth_tokens WHERE expires_at < ?").bind(at),
		// Past the grace window a rotated token's successor is never opened again.
		db
			.prepare("UPDATE mcp_oauth_tokens SET successor = NULL WHERE successor IS NOT NULL AND rotated_at < ?")
			.bind(at - graceSeconds),
	]);
	const { results } = await db
		.prepare(
			"SELECT key_id FROM mcp_oauth_grants g WHERE NOT EXISTS (SELECT 1 FROM mcp_oauth_tokens t WHERE t.key_id = g.key_id AND t.kind = 'refresh' AND t.rotated_at IS NULL) LIMIT ?",
		)
		.bind(PRUNE_BATCH)
		.all<{ key_id: string }>();
	for (const { key_id } of results) await deleteGrant(env, key_id);
	await db.batch([
		db
			.prepare(
				"DELETE FROM api_keys WHERE kind = 'oauth' AND created_at < ? AND id NOT IN (SELECT key_id FROM mcp_oauth_grants)",
			)
			.bind(at - 60 * 60),
		db
			.prepare(
				"DELETE FROM mcp_oauth_clients WHERE NOT EXISTS (SELECT 1 FROM mcp_oauth_grants g WHERE g.client_id = mcp_oauth_clients.id) AND ((last_used_at IS NULL AND created_at < ?) OR last_used_at < ?)",
			)
			.bind(at - unusedClientTtlSeconds, at - idleClientTtlSeconds),
	]);
	return results.length;
}
