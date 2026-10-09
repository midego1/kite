-- Indexes for the hottest list queries. `messages_counts_idx` covers the
-- folder counts GROUP BY so it reads only index pages; the rebuilt
-- `messages_thread_key_idx` adds the descending sort keys plus `direction` and
-- `snoozed_until`, which makes conversation paging and totals index-only;
-- `messages_starred_idx` stops the Starred view scanning the whole mailbox.
-- `messages_mailbox_idx` is dropped because every one of these leads with
-- `mailbox_id`, so it only cost writes.
CREATE INDEX IF NOT EXISTS `messages_counts_idx` ON `messages` (`mailbox_id`, `status`, `direction`, `folder_id`, `read`, `starred`, `snoozed_until`);--> statement-breakpoint
DROP INDEX IF EXISTS `messages_thread_key_idx`;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `messages_thread_key_idx` ON `messages` (`mailbox_id`, `status`, `folder_id`, coalesce(`thread_id`, `id`), `created_at` DESC, `id` DESC, `direction`, `snoozed_until`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `messages_starred_idx` ON `messages` (`mailbox_id`, `starred`, coalesce(`thread_id`, `id`), `created_at` DESC, `id` DESC);--> statement-breakpoint
DROP INDEX IF EXISTS `messages_mailbox_idx`;
