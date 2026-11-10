-- Sign in with Microsoft for connected accounts (ROADMAP milestone 6 item 4, spec §10.4 and §15). An OAuth account
-- keeps its sealed refresh token in `external_accounts.secret`, where a password account keeps its password, so
-- every path that erases or strips the password (retention, backups, restore) does the same for the token. The
-- access token is cached sealed until 5 minutes before `oauth_expires_at`; `oauth_token_version` is the
-- compare-and-swap that keeps one refresh per account. None of these columns is mapped in Drizzle, so whole-row reads
-- and inserts keep working before this migration is applied; `src/lib/external-accounts/oauth-store.ts` reads them
-- with plain SQL. `app_settings.oauth_microsoft_client` is the owner's sealed Entra app registration
-- (`{ clientId, clientSecret, tenant }`). `oauth_states` holds one sign-in in progress for 10 minutes, keyed by the
-- SHA-256 of its `state`, with the PKCE verifier sealed; it is internal (not in backups).
ALTER TABLE `external_accounts` ADD `oauth_access_token` text;--> statement-breakpoint
ALTER TABLE `external_accounts` ADD `oauth_expires_at` integer;--> statement-breakpoint
ALTER TABLE `external_accounts` ADD `oauth_scopes` text;--> statement-breakpoint
ALTER TABLE `external_accounts` ADD `oauth_token_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `external_accounts` ADD `oauth_subject` text;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `oauth_microsoft_client` text;--> statement-breakpoint
CREATE TABLE `oauth_states` (`state_hash` text PRIMARY KEY NOT NULL, `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade, `provider` text NOT NULL, `code_verifier` text NOT NULL, `account_id` text REFERENCES `external_accounts`(`id`) ON DELETE cascade, `payload` text DEFAULT '{}' NOT NULL, `expires_at` integer NOT NULL, `created_at` integer NOT NULL);--> statement-breakpoint
CREATE INDEX `oauth_states_expires_idx` ON `oauth_states` (`expires_at`);
