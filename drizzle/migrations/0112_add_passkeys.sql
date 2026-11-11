-- Passkeys (WebAuthn) for sign-in. `passkeys` holds each credential's public key (the COSE key, base64url), its
-- algorithm, last signature counter and the transports the browser reported; never a private key. It is backed up
-- with the accounts. `passkey_challenges` holds ceremonies in progress (single-use, five minutes), keyed by the
-- SHA-256 of a token only the browser holds; it is internal and not backed up.
CREATE TABLE `passkeys` (`id` text PRIMARY KEY NOT NULL, `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade, `credential_id` text NOT NULL, `public_key` text NOT NULL, `algorithm` integer NOT NULL, `sign_count` integer DEFAULT 0 NOT NULL, `transports` text, `aaguid` text, `backup_eligible` integer DEFAULT false NOT NULL, `backed_up` integer DEFAULT false NOT NULL, `name` text NOT NULL, `created_at` integer NOT NULL, `last_used_at` integer);--> statement-breakpoint
CREATE UNIQUE INDEX `passkeys_credential_id_unique` ON `passkeys` (`credential_id`);--> statement-breakpoint
CREATE INDEX `passkeys_user_idx` ON `passkeys` (`user_id`);--> statement-breakpoint
CREATE TABLE `passkey_challenges` (`id` text PRIMARY KEY NOT NULL, `token_hash` text NOT NULL, `purpose` text NOT NULL, `challenge` text NOT NULL, `user_id` text REFERENCES `users`(`id`) ON DELETE cascade, `session_hash` text, `expires_at` integer NOT NULL, `created_at` integer NOT NULL);--> statement-breakpoint
CREATE UNIQUE INDEX `passkey_challenges_token_hash_unique` ON `passkey_challenges` (`token_hash`);--> statement-breakpoint
CREATE INDEX `passkey_challenges_expires_idx` ON `passkey_challenges` (`expires_at`);
