-- "Scan last 90 days" (docs/specs/money-watch.md §25.5): a short message for a scan the five-minute safety net gave
-- up on after it stayed stalled too long, so the Payments tab can show it with Try again instead of retrying forever.
-- `progress_at` is when a page last actually saved progress, never bumped by a lease pickup alone (unlike
-- `updated_at`), so the safety net can tell a scan that keeps being leased and crashing from one making progress.
ALTER TABLE `finance_payment_scans` ADD `error` text;--> statement-breakpoint
ALTER TABLE `finance_payment_scans` ADD `progress_at` integer;
