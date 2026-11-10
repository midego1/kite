-- Search by meaning, queue origin (follow-up to 0099): `message_embeddings.origin` records who queued a row, 'live'
-- (a delivered message, a rebuild or a mailbox requeue) or 'backfill' (a page of the install backfill), so the drain
-- charges the backfill's own spend against its cap share by what the row is instead of guessing from how old its
-- `queued_at` is. Only the backfill's insert writes 'backfill'; everything that queues a row again resets it to 'live'
-- (the status-change trigger below, the rebuild and the mailbox requeue). Rows the backfill queued before this
-- migration and that are still waiting keep their classification: they are the ones queued well in the past.
-- `src/lib/semantic/indexer.ts` falls back to the old age rule on a database that has not applied it yet.
ALTER TABLE `message_embeddings` ADD `origin` text DEFAULT 'live' NOT NULL;--> statement-breakpoint
UPDATE `message_embeddings` SET `origin` = 'backfill' WHERE `status` IN ('pending', 'running') AND `queued_at` < CAST(strftime('%s', 'now') AS integer) - 600;--> statement-breakpoint
DROP TRIGGER IF EXISTS `message_embeddings_messages_au`;--> statement-breakpoint
CREATE TRIGGER `message_embeddings_messages_au` AFTER UPDATE OF `status` ON `messages`
WHEN (SELECT `semantic_search_enabled` FROM `app_settings` LIMIT 1) = 1
	AND new.`mailbox_id` IS NOT NULL
	AND new.`status` IN ('received', 'sent', 'archived')
	AND (new.`spam_verdict` IS NULL OR new.`spam_verdict` <> 'spam')
	AND NOT coalesce((SELECT `ai_disabled` FROM `mailbox_agent_settings` WHERE `mailbox_id` = new.`mailbox_id`), false)
	AND NOT (
		old.`status` IN ('received', 'sent', 'archived')
		AND (old.`spam_verdict` IS NULL OR old.`spam_verdict` <> 'spam')
	)
BEGIN
	INSERT INTO `message_embeddings` (`message_id`, `mailbox_id`, `status`, `queued_at`)
	VALUES (new.`id`, new.`mailbox_id`, 'pending', CAST(strftime('%s', 'now') AS integer))
	ON CONFLICT(`message_id`) DO UPDATE SET `status` = 'pending', `queued_at` = CAST(strftime('%s', 'now') AS integer), `lease_until` = NULL, `origin` = 'live'
	WHERE `message_embeddings`.`status` = 'skipped';
END;
