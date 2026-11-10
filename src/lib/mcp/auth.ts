import { and, eq, lt, or, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { apiKeys, mcpKeyMailboxes, users } from "@/db/schema";
import { parseScopes, verifyApiKey } from "@/lib/api-keys";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { ADMIN_API_KEY_SCOPES } from "@/lib/api/scopes";
import { allKeyScopes, scopeDeclarations } from "@/lib/modules/key-scope-utils";
import { MODULE_MANIFESTS } from "@/lib/modules/registry";
import { grantOfAccessToken } from "./oauth/service";
import { OAUTH_ACCESS_TOKEN_PREFIX } from "./oauth/utils";
import type { McpPrincipal } from "./types";

/** Core scopes plus every module's, on or off, so a key keeps authenticating while its module is off. */
const MCP_SCOPES = new Set(allKeyScopes(scopeDeclarations(MODULE_MANIFESTS), "mcp"));
const ADMIN_SCOPES = new Set<string>(ADMIN_API_KEY_SCOPES);

type KeyRow = typeof apiKeys.$inferSelect;

/**
 * The principal of an MCP key or an OAuth grant (an `api_keys` row of kind `oauth`): the same scope rules, the same
 * mailboxes the user can still read, and `lastUsedAt` refreshed at most once a minute.
 */
async function principalForKey(env: CloudflareEnv, candidate: KeyRow): Promise<McpPrincipal | null> {
	const db = getDb(env);
	const allScopes = parseScopes(candidate.scopes);
	const isMailKey = allScopes.length > 0 && allScopes.every((scope) => MCP_SCOPES.has(scope));
	const isAdminKey =
		candidate.kind !== "oauth" && allScopes.length > 0 && allScopes.every((scope) => ADMIN_SCOPES.has(scope));
	if (!isMailKey && !isAdminKey) return null;
	const [user] = await db.select().from(users).where(eq(users.id, candidate.userId)).limit(1);
	if (!user || user.disabled) return null;
	if (isAdminKey && user.role !== "admin") return null;
	const allowed = isMailKey
		? await db
				.select({ mailboxId: mcpKeyMailboxes.mailboxId })
				.from(mcpKeyMailboxes)
				.where(eq(mcpKeyMailboxes.keyId, candidate.id))
		: [];
	const mailboxIds: string[] = [];
	for (const { mailboxId } of allowed)
		if ((await getMailboxAccessLevel(db, user, mailboxId))?.canRead) mailboxIds.push(mailboxId);
	const stale = new Date(Date.now() - 60_000);
	await db
		.update(apiKeys)
		.set({ lastUsedAt: new Date() })
		.where(and(eq(apiKeys.id, candidate.id), or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, stale))));
	return { keyId: candidate.id, user, scopes: allScopes, mailboxIds };
}

async function authenticateOAuthToken(env: CloudflareEnv, token: string, resource: string) {
	const keyId = await grantOfAccessToken(env, token, resource);
	if (!keyId) return null;
	const [grant] = await getDb(env)
		.select()
		.from(apiKeys)
		.where(and(eq(apiKeys.id, keyId), eq(apiKeys.kind, "oauth")))
		.limit(1);
	return grant ? principalForKey(env, grant) : null;
}

/**
 * An MCP key (`ep_…`) or an OAuth access token (`kite_at_…`) bound to `resource`, Kite's MCP endpoint (RFC 8707).
 */
export async function authenticateMcpRequest(
	env: CloudflareEnv,
	request: Request,
	resource: string,
): Promise<McpPrincipal | null> {
	const authorization = request.headers.get("Authorization") ?? "";
	if (!authorization.startsWith("Bearer ")) return null;
	const key = authorization.slice(7).trim();
	if (key.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)) return authenticateOAuthToken(env, key, resource);
	if (!key.startsWith("ep_") || key.length > 256) return null;
	const candidates = await getDb(env)
		.select()
		.from(apiKeys)
		.where(and(eq(apiKeys.prefix, key.slice(0, 12)), eq(apiKeys.kind, "mcp")));
	for (const candidate of candidates) {
		if (!verifyApiKey(key, candidate.keyHash)) continue;
		return principalForKey(env, candidate);
	}
	return null;
}
