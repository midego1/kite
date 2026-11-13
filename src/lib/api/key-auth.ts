import { and, eq, lt, ne, or, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { primaryDatabase } from "@/lib/d1-session-utils";
import { apiKeys, mcpKeyMailboxes, users } from "@/db/schema";
import { parseScopes, verifyApiKey } from "@/lib/api-keys";
import type { ApiAuthResult } from "@/lib/api/key-auth-types";
import { ADMIN_API_KEY_SCOPES } from "@/lib/api/scopes";

const LAST_USED_WRITE_INTERVAL_MS = 60_000;
const ADMIN_SCOPES = new Set<string>(ADMIN_API_KEY_SCOPES);

/**
 * Resolve an API key to its user and scopes. Framework-free so it can run in
 * `worker.ts` as well as route handlers. `lastUsedAt` is refreshed at most
 * once a minute per key, since protocol clients make many small calls.
 */
export async function authenticateApiKeyValue(env: CloudflareEnv, key: string): Promise<ApiAuthResult | null> {
	const trimmed = key.trim();
	if (!trimmed) return null;
	const prefix = trimmed.slice(0, 12);
	// The primary: a read replica could still accept a key that was just revoked or a user just disabled.
	const db = getDb({ DB: primaryDatabase(env.DB) });
	// An OAuth grant (kind `oauth`) is an MCP-only credential and has no key; its tokens never reach this path.
	const candidates = await db
		.select()
		.from(apiKeys)
		.where(and(eq(apiKeys.prefix, prefix), ne(apiKeys.kind, "oauth")));

	for (const candidate of candidates) {
		if (!verifyApiKey(trimmed, candidate.keyHash)) continue;
		const [user] = await db.select().from(users).where(eq(users.id, candidate.userId)).limit(1);
		if (!user || user.disabled) continue;

		const stale = new Date(Date.now() - LAST_USED_WRITE_INTERVAL_MS);
		await db
			.update(apiKeys)
			.set({ lastUsedAt: new Date() })
			.where(and(eq(apiKeys.id, candidate.id), or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, stale))));

		const scopes = parseScopes(candidate.scopes);
		const allowed = candidate.mailboxScopeEnabled
			? await db
					.select({ mailboxId: mcpKeyMailboxes.mailboxId })
					.from(mcpKeyMailboxes)
					.where(eq(mcpKeyMailboxes.keyId, candidate.id))
			: null;
		return {
			userId: user.id,
			email: user.email,
			scopes: scopes.some((scope) => ADMIN_SCOPES.has(scope))
				? scopes.filter((scope) => ADMIN_SCOPES.has(scope))
				: scopes,
			mailboxIds: allowed?.map((row) => row.mailboxId) ?? null,
			user,
		};
	}
	return null;
}

/**
 * JMAP clients send the key either as a Bearer token or as the password of
 * HTTP Basic auth (the username is ignored; the key identifies the account).
 */
export async function authenticateApiRequest(env: CloudflareEnv, request: Request): Promise<ApiAuthResult | null> {
	const authorization = request.headers.get("Authorization") ?? "";
	if (authorization.startsWith("Bearer ")) return authenticateApiKeyValue(env, authorization.slice(7));
	if (authorization.startsWith("Basic ")) {
		let decoded = "";
		try {
			decoded = atob(authorization.slice(6).trim());
		} catch {
			return null;
		}
		const separator = decoded.indexOf(":");
		return authenticateApiKeyValue(env, separator >= 0 ? decoded.slice(separator + 1) : decoded);
	}
	return null;
}

export function hasScope(scopes: string[], required: string): boolean {
	return scopes.includes(required) || scopes.includes("*");
}
