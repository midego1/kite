/**
 * Scopes an API key can be granted. Kept free of server-only imports so the
 * dashboard's key-creation form can import it without pulling in bcrypt.
 * Administrative scopes are issued separately from personal mail keys.
 * Modules add their own scopes through their manifests (`apiKeyScopes`, `mcpScopes`).
 */
export const CORE_API_KEY_SCOPES = ["send", "read", "jmap"] as const;

/** A core scope or one a module declares, such as `calendar:read`. */
export type ApiKeyScope = string;

/** Scopes of an MCP key for mail; modules add theirs in `mcpScopes`. */
export const CORE_MCP_SCOPES = ["mcp:read", "mcp:draft", "mcp:organize", "mcp:request-send"] as const;

/** Most mailboxes one personal API key (including an app password) may be granted. */
export const API_KEY_MAX_MAILBOXES = 30;

export const ADMIN_API_KEY_SCOPES = ["domains", "accounts", "mailboxes"] as const;
