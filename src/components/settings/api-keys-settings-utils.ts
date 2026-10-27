import { authFetch } from "@/lib/auth/client";
import type { ApiKeyScope } from "@/lib/api/scopes";
import { CLIENT_MODULES } from "@/lib/modules/client-data";
import {
	clientScopeDeclarations,
	isScopeAvailable,
	keyScopeOptions,
	scopesNeedMailbox,
	type KeyScopeKind,
	type KeyScopeOption,
} from "@/lib/modules/key-scope-utils";
import type { ModuleId } from "@/lib/modules/module-types";
import type { ManagedApiKey, McpKeyScope } from "./api-keys-settings-types";

const SCOPE_DECLARATIONS = clientScopeDeclarations(CLIENT_MODULES);

/** The options the signed-in user may pick: core scopes always, a module's only while it is on for them. */
export function keyScopeChoices(kind: KeyScopeKind, enabled: readonly ModuleId[]): KeyScopeOption[] {
	return keyScopeOptions(kind, kind === "mcp" ? MCP_KEY_SCOPES : STANDARD_KEY_SCOPES, CLIENT_MODULES, enabled);
}

/** The chosen scopes that are still on offer, so a scope picked before its module was turned off is never submitted. */
export function enabledScopes(kind: KeyScopeKind, scopes: readonly string[], enabled: readonly ModuleId[]): string[] {
	return scopes.filter((scope) => isScopeAvailable(SCOPE_DECLARATIONS, kind, scope, enabled));
}

/** Whether the chosen scopes need at least one allowed mailbox. */
export function scopesNeedMailboxes(kind: KeyScopeKind, scopes: readonly string[]): boolean {
	return scopesNeedMailbox(SCOPE_DECLARATIONS, kind, scopes);
}

const MCP_KEY_SCOPES: { value: McpKeyScope; label: string; description: string }[] = [
	{ value: "mcp:read", label: "Read mail", description: "List, search, count, and read messages, and list folders." },
	{ value: "mcp:draft", label: "Manage drafts", description: "Create, edit, and discard drafts." },
	{
		value: "mcp:organize",
		label: "Organize mail",
		description: "Mark messages read or unread, move them, and create folders and file mail in them.",
	},
	{
		value: "mcp:request-send",
		label: "Request send review",
		description: "Propose a send that you must confirm in Kite.",
	},
];

const STANDARD_KEY_SCOPES: { value: ApiKeyScope; label: string; description: string }[] = [
	{ value: "read", label: "Read mail", description: "Read messages through the API." },
	{ value: "send", label: "Send mail", description: "Send messages directly through the API." },
];

type ApiKeysResponse = { error?: unknown; key?: string; apiKeys?: ManagedApiKey[] };

async function responseData(response: Response): Promise<ApiKeysResponse> {
	return response.json<ApiKeysResponse>().catch(() => ({}));
}

export function keyPermissions(key: ManagedApiKey): string[] {
	try {
		const scopes: unknown = JSON.parse(key.scopes);
		return Array.isArray(scopes) ? scopes.filter((scope): scope is string => typeof scope === "string") : [];
	} catch {
		return [];
	}
}

export async function loadManagedApiKeys(): Promise<ManagedApiKey[]> {
	const response = await authFetch("/api/api-keys");
	const data = await responseData(response);
	if (!response.ok || !data.apiKeys)
		throw new Error(typeof data.error === "string" ? data.error : "Could not load API keys");
	return data.apiKeys;
}

export async function createManagedApiKey(input: {
	name: string;
	mcpAllowed: boolean;
	scopes: ApiKeyScope[] | McpKeyScope[];
	mailboxIds: string[];
}): Promise<string> {
	const response = await authFetch(input.mcpAllowed ? "/api/agent/mcp-keys" : "/api/api-keys", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name: input.name, scopes: input.scopes, mailboxIds: input.mailboxIds }),
	});
	const data = await responseData(response);
	if (!response.ok || !data.key)
		throw new Error(typeof data.error === "string" ? data.error : "Could not create API key");
	return data.key;
}

export async function revokeManagedApiKey(id: string): Promise<void> {
	const response = await authFetch(`/api/api-keys?id=${encodeURIComponent(id)}`, { method: "DELETE" });
	if (!response.ok) {
		const data = await responseData(response);
		throw new Error(typeof data.error === "string" ? data.error : "Could not revoke API key");
	}
}
