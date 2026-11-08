-- "Keep receipts" (docs/specs/money-watch.md "Keep receipts"): Money Watch copies the mail and its receipt into the
-- owner's Drive under `Money Watch/Receipts/<year>/`, so a tracked payment, subscription document or document
-- backfill keeps working after the mail is purged or deleted forever. `finance_receipts` holds one row per filed
-- `finance_subscriptions`, `finance_charges` or `finance_payments` row (its existence is the idempotency claim);
-- `finance_receipt_settings` is the per-user on/off switch (default on); `finance_receipt_backfills` is the resumable
-- "Save receipts for existing payments" cursor, one run at a time per owner, like `finance_payment_scans`.
CREATE TABLE `finance_receipts` (`id` text PRIMARY KEY NOT NULL, `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade, `source_table` text NOT NULL, `source_id` text NOT NULL, `message_id` text REFERENCES `messages`(`id`) ON DELETE set null, `eml_file_id` text, `html_file_id` text, `pdf_file_id` text, `attachment_file_id` text, `status` text NOT NULL, `skipped_reason` text, `filed_at` integer, `created_at` integer NOT NULL, `updated_at` integer NOT NULL);--> statement-breakpoint
CREATE UNIQUE INDEX `finance_receipts_source_idx` ON `finance_receipts` (`source_table`,`source_id`);--> statement-breakpoint
CREATE INDEX `finance_receipts_user_idx` ON `finance_receipts` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `finance_receipt_settings` (`user_id` text PRIMARY KEY NOT NULL REFERENCES `users`(`id`) ON DELETE cascade, `enabled` integer DEFAULT true NOT NULL, `updated_at` integer NOT NULL);--> statement-breakpoint
CREATE TABLE `finance_receipt_backfills` (`user_id` text PRIMARY KEY NOT NULL REFERENCES `users`(`id`) ON DELETE cascade, `status` text NOT NULL, `scanned` integer DEFAULT 0 NOT NULL, `filed` integer DEFAULT 0 NOT NULL, `skipped` integer DEFAULT 0 NOT NULL, `lease_until` integer, `started_at` integer NOT NULL, `updated_at` integer NOT NULL, `finished_at` integer);
