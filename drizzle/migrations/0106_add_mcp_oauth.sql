-- MCP over OAuth 2.1 (ROADMAP milestone 4 item 3). An MCP client registers itself (RFC 7591, public clients only) in
-- `mcp_oauth_clients`; a signed-in user's consent stores a single-use authorization code (`mcp_oauth_codes`, keyed by
-- its SHA-256, with the S256 PKCE challenge); redeeming it creates the grant. A grant is an `api_keys` row of kind
-- `oauth` (no usable key: its hash is not a bcrypt hash) with the chosen scopes and its `mcp_key_mailboxes`, so tool
-- filtering, mailbox access, audit rows and send requests work exactly as for an MCP key, plus `mcp_oauth_grants`
-- (client, redirect URI and the resource the tokens are bound to). `mcp_oauth_tokens` holds the SHA-256 of each
-- access token (1 hour) and refresh token (30 days, rotated on use; a rotated one presented again revokes the grant).
-- Deleting the `api_keys` row revokes everything. All four tables are internal (not in backups). None is mapped in
-- Drizzle; `src/lib/mcp/oauth/store.ts` reads and writes them with plain SQL.
CREATE TABLE `mcp_oauth_clients` (`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL, `redirect_uris` text NOT NULL, `created_at` integer NOT NULL, `last_used_at` integer);--> statement-breakpoint
CREATE INDEX `mcp_oauth_clients_created_idx` ON `mcp_oauth_clients` (`created_at`);--> statement-breakpoint
CREATE TABLE `mcp_oauth_codes` (`code_hash` text PRIMARY KEY NOT NULL, `client_id` text NOT NULL REFERENCES `mcp_oauth_clients`(`id`) ON DELETE cascade, `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade, `redirect_uri` text NOT NULL, `code_challenge` text NOT NULL, `resource` text NOT NULL, `scopes` text NOT NULL, `mailbox_ids` text DEFAULT '[]' NOT NULL, `expires_at` integer NOT NULL, `used_at` integer, `key_id` text, `created_at` integer NOT NULL);--> statement-breakpoint
CREATE INDEX `mcp_oauth_codes_expires_idx` ON `mcp_oauth_codes` (`expires_at`);--> statement-breakpoint
CREATE TABLE `mcp_oauth_grants` (`key_id` text PRIMARY KEY NOT NULL REFERENCES `api_keys`(`id`) ON DELETE cascade, `client_id` text NOT NULL REFERENCES `mcp_oauth_clients`(`id`) ON DELETE cascade, `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade, `redirect_uri` text NOT NULL, `resource` text NOT NULL, `created_at` integer NOT NULL);--> statement-breakpoint
CREATE INDEX `mcp_oauth_grants_user_idx` ON `mcp_oauth_grants` (`user_id`, `client_id`);--> statement-breakpoint
CREATE INDEX `mcp_oauth_grants_client_idx` ON `mcp_oauth_grants` (`client_id`);--> statement-breakpoint
CREATE TABLE `mcp_oauth_tokens` (`token_hash` text PRIMARY KEY NOT NULL, `key_id` text NOT NULL REFERENCES `mcp_oauth_grants`(`key_id`) ON DELETE cascade, `kind` text NOT NULL, `expires_at` integer NOT NULL, `rotated_at` integer, `created_at` integer NOT NULL);--> statement-breakpoint
CREATE INDEX `mcp_oauth_tokens_key_idx` ON `mcp_oauth_tokens` (`key_id`, `kind`);--> statement-breakpoint
CREATE INDEX `mcp_oauth_tokens_expires_idx` ON `mcp_oauth_tokens` (`expires_at`);
