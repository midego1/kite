-- "Scan last 90 days" (docs/specs/money-watch.md §25.5): a short message for a scan the five-minute safety net gave
-- up on after it stayed stalled too long, so the Payments tab can show it with Try again instead of retrying forever.
ALTER TABLE `finance_payment_scans` ADD `error` text;
