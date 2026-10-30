-- Connected accounts (docs/specs/external-accounts.md §7.2, §11): an address is unique per install only where the sign-in
-- proves it. A known provider's own servers check that the user owns the address; an "Other" account names its own
-- server, which can accept any address, so its address claims nothing and may be connected again by someone else.
DROP INDEX IF EXISTS `external_accounts_address_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `external_accounts_address_idx` ON `external_accounts` (`address`) WHERE `preset` <> 'other';
