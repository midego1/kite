-- Indexes for two periodic scans (follow-ups to 0106 and 0102).
-- `mcp_oauth_tokens_successor_idx`: the five-minute run drops a rotated refresh token's sealed grace pair once its
-- minute is over (`clearExpiredSuccessors` in `src/lib/mcp/oauth/store.ts`). Rotated tokens stay until they expire,
-- 30 days, so the table grows with every refresh; the partial index holds only the few rows that still carry a pair.
CREATE INDEX IF NOT EXISTS `mcp_oauth_tokens_successor_idx` ON `mcp_oauth_tokens` (`rotated_at`) WHERE `successor` IS NOT NULL;--> statement-breakpoint
-- `finance_receipts_user_updated_idx`: the receipt sweep orders owners by when their receipts were last touched,
-- `max(updated_at)` per owner (`ownerLastServed` in `src/lib/finance/receipt-candidates.ts`); with this index that is
-- one seek per owner instead of a scan of all of the owner's rows.
CREATE INDEX IF NOT EXISTS `finance_receipts_user_updated_idx` ON `finance_receipts` (`user_id`, `updated_at`);
