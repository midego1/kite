-- Payments by mail in Money Watch (docs/specs/money-watch.md §25): one row per payment document found in a message
-- (invoice, payment, credit note or refund) that is not a tracked subscription's. One row per owner and message, per
-- copy of a message delivered to several mailboxes (`mail_ref`, its Message-ID) and per vendor, type and document number
-- (`doc_ref`, so a reminder of an invoice is not a second invoice). A removed row stays as a tombstone so the message is
-- never recorded again. The scan table is the bookkeeping of
-- "Scan last 90 days" and is internal (not in backups).
CREATE TABLE `finance_payments` (`id` text PRIMARY KEY NOT NULL, `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade, `mailbox_id` text REFERENCES `mailboxes`(`id`) ON DELETE set null, `message_id` text REFERENCES `messages`(`id`) ON DELETE set null, `attachment_id` text, `vendor` text NOT NULL, `vendor_key` text NOT NULL, `doc_type` text NOT NULL, `status` text NOT NULL, `amount_minor` integer NOT NULL, `currency` text NOT NULL, `document_at` integer NOT NULL, `source` text NOT NULL, `doc_ref` text, `mail_ref` text, `model_fields` text, `removed_at` integer, `created_at` integer NOT NULL, `updated_at` integer NOT NULL);--> statement-breakpoint
CREATE UNIQUE INDEX `finance_payments_message_idx` ON `finance_payments` (`user_id`,`message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `finance_payments_mail_ref_idx` ON `finance_payments` (`user_id`,`mail_ref`);--> statement-breakpoint
CREATE UNIQUE INDEX `finance_payments_doc_ref_idx` ON `finance_payments` (`user_id`,`vendor_key`,`doc_type`,`doc_ref`);--> statement-breakpoint
CREATE INDEX `finance_payments_user_idx` ON `finance_payments` (`user_id`,`document_at`);--> statement-breakpoint
CREATE TABLE `finance_payment_scans` (`user_id` text PRIMARY KEY NOT NULL REFERENCES `users`(`id`) ON DELETE cascade, `status` text NOT NULL, `since_at` integer NOT NULL, `cursor_at` integer, `cursor_id` text, `scanned` integer DEFAULT 0 NOT NULL, `recorded` integer DEFAULT 0 NOT NULL, `skipped` integer DEFAULT 0 NOT NULL, `lease_until` integer, `started_at` integer NOT NULL, `updated_at` integer NOT NULL, `finished_at` integer);
