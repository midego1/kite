export type ManagedApiKey = {
	id: string;
	name: string;
	prefix: string;
	kind: "legacy" | "mcp";
	scopes: string;
	mailboxIds: string[];
	mailboxScopeEnabled: boolean;
	createdAt: string;
	lastUsedAt: string | null;
};

/** A core MCP scope or one a module declares. */
export type McpKeyScope = string;
