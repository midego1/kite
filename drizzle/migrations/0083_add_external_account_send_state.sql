-- Send-as (docs/specs/external-accounts.md §7.2): when the account's SMTP sign-in last succeeded with its saved
-- password. Only then is the login address offered in the From menu; null until the next connection test.
ALTER TABLE `external_accounts` ADD `smtp_verified_at` integer;
