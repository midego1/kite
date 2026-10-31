-- Send-as verification codes (docs/specs/external-accounts.md §7.2, §10.3): an address a connected account may send
-- as once the owner entered the 6-digit code Kite mailed to it. A provider alias, or the account's own address when
-- the sign-in does not prove it (an "Other" server, or a user name that is not the address). The code is stored only
-- as an HMAC, valid 30 minutes and for 5 attempts; a removed account takes its addresses with it.
CREATE TABLE `external_identities` (`id` text PRIMARY KEY NOT NULL, `account_id` text NOT NULL REFERENCES `external_accounts`(`id`) ON DELETE cascade, `address` text NOT NULL, `display_name` text, `verified_at` integer, `code_hash` text, `code_expires_at` integer, `attempts` integer DEFAULT 0 NOT NULL, `created_at` integer NOT NULL);--> statement-breakpoint
CREATE UNIQUE INDEX `external_identities_account_address_idx` ON `external_identities` (`account_id`,`address`);
