-- "Keep receipts" (docs/specs/money-watch.md "Keep receipts"): Money Watch copies the mail and its receipt into the
-- owner's Drive under `Money Watch/Receipts/<year>/`, so a tracked payment, subscription document or document
-- backfill keeps working after the mail is purged or deleted forever. `finance_receipts` holds one row per
-- claimed-or-filed `finance_subscriptions`, `finance_charges` or `finance_payments` row: a row is inserted as
-- `pending` (the claim, made before Drive is ever called) and then updated to `done` or `skipped`, so the claim
-- itself, not the Drive write, is what makes filing idempotent; `lease_until` lets another run take over a claim
-- whose run died, growing with `attempts` on each transient failure (full quota, Drive unavailable) so a owner
-- stuck that way is retried less and less often instead of occupying every sweep tick's row budget forever.
-- `finance_receipt_settings` is the per-user on/off switch (default on); `finance_receipt_backfills` is the
-- resumable "Save receipts for existing payments" cursor, one run at a time per owner, like
-- `finance_payment_scans`; its `pending` count is rows left retryable (a transient failure, not a permanent
-- skip), reported apart from `skipped` so "done" never reads as "every row was filed or truly skipped" when some
-- are still only waiting out their lease. `app_settings.finance_receipts_sweep_since` (read and written as plain
-- SQL, like `attachment_storage_job`, so a deploy ahead of this migration still works) is set once, the first
-- time the automatic sweep ever runs, to the time it first ran: the sweep only ever auto-files a row created from
-- that point on, so a fresh deploy never auto-files a user's whole history at once (that is what the backfill is for).
CREATE TABLE `finance_receipts` (`id` text PRIMARY KEY NOT NULL, `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade, `source_table` text NOT NULL, `source_id` text NOT NULL, `message_id` text REFERENCES `messages`(`id`) ON DELETE set null, `eml_file_id` text, `html_file_id` text, `pdf_file_id` text, `attachment_file_id` text, `status` text NOT NULL, `skipped_reason` text, `lease_until` integer, `attempts` integer DEFAULT 0 NOT NULL, `filed_at` integer, `created_at` integer NOT NULL, `updated_at` integer NOT NULL);--> statement-breakpoint
CREATE UNIQUE INDEX `finance_receipts_source_idx` ON `finance_receipts` (`source_table`,`source_id`);--> statement-breakpoint
CREATE INDEX `finance_receipts_user_idx` ON `finance_receipts` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `finance_receipt_settings` (`user_id` text PRIMARY KEY NOT NULL REFERENCES `users`(`id`) ON DELETE cascade, `enabled` integer DEFAULT true NOT NULL, `updated_at` integer NOT NULL);--> statement-breakpoint
CREATE TABLE `finance_receipt_backfills` (`user_id` text PRIMARY KEY NOT NULL REFERENCES `users`(`id`) ON DELETE cascade, `status` text NOT NULL, `scanned` integer DEFAULT 0 NOT NULL, `filed` integer DEFAULT 0 NOT NULL, `skipped` integer DEFAULT 0 NOT NULL, `pending` integer DEFAULT 0 NOT NULL, `lease_until` integer, `started_at` integer NOT NULL, `updated_at` integer NOT NULL, `finished_at` integer);--> statement-breakpoint
ALTER TABLE `app_settings` ADD `finance_receipts_sweep_since` integer;
