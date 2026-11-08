-- Search by meaning (docs/specs/semantic-search.md): `message_embeddings` is one row per message tracking its
-- embedding state, kept by triggers so every path that creates or changes mail is covered without code in each.
-- `vector_key` is left for application code to fill in (the first 32 hex characters of SHA-256 of the message id;
-- SQLite/D1 has no built-in SHA-256 function), so a message deleted before it was ever claimed by the drain leaves a
-- tombstone with no key and nothing for the vector store to remove. `message_embedding_deletes` is the tombstone
-- queue the drain works through to remove vectors of deleted messages; it has no primary key, drained by rowid.
-- Both tables are internal (derived from `messages`, rebuilt by the triggers) and are not backed up.
CREATE TABLE `message_embeddings` (`message_id` text PRIMARY KEY NOT NULL, `mailbox_id` text, `vector_key` text, `status` text DEFAULT 'pending' NOT NULL, `chunk_count` integer DEFAULT 0 NOT NULL, `content_hash` text, `model` text, `attempts` integer DEFAULT 0 NOT NULL, `error` text, `lease_until` integer, `queued_at` integer, `indexed_at` integer);--> statement-breakpoint
CREATE INDEX `message_embeddings_status_queued_idx` ON `message_embeddings` (`status`,`queued_at`);--> statement-breakpoint
CREATE INDEX `message_embeddings_mailbox_idx` ON `message_embeddings` (`mailbox_id`);--> statement-breakpoint
CREATE INDEX `message_embeddings_vector_key_idx` ON `message_embeddings` (`vector_key`);--> statement-breakpoint
CREATE TABLE `message_embedding_deletes` (`vector_key` text, `chunk_count` integer DEFAULT 0 NOT NULL, `created_at` integer NOT NULL);--> statement-breakpoint
CREATE INDEX `message_embedding_deletes_created_idx` ON `message_embedding_deletes` (`created_at`);--> statement-breakpoint
-- Install settings: off by default for every install. `semantic_embedding_provider` names the Node fallback only
-- (Workers always uses the `AI` binding); the compatible endpoint's key is sealed with APP_ENCRYPTION_KEY, as other
-- provider secrets are. The backfill cursor is the `created_at, id` of the oldest message queued so far.
ALTER TABLE `app_settings` ADD `semantic_search_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `semantic_embedding_provider` text;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `semantic_compatible_base_url` text;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `semantic_compatible_api_key` text;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `semantic_backfill_cursor` text;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `semantic_backfill_paused` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `semantic_backfill_cap_share` integer DEFAULT 50 NOT NULL;--> statement-breakpoint
-- Per-mailbox switch (Settings -> Assistant): on by default, so a mailbox is indexed unless its manager excludes it.
ALTER TABLE `mailbox_agent_settings` ADD `semantic_index` integer DEFAULT true NOT NULL;--> statement-breakpoint
-- Enqueueing. Never for a mailbox with "No AI for this mailbox" on (`mailbox_agent_settings.ai_disabled`, migration
-- 0091): that switch keeps a mailbox's mail away from every AI provider, embeddings included, so no row is ever
-- queued for it, regardless of `semantic_search_enabled`. The per-mailbox `semantic_index` switch is checked at drain
-- time instead (section 5 of the spec), not here, so it can skip and clear a mailbox's rows explicitly when it is
-- turned off without waiting for the next message.
CREATE TRIGGER `message_embeddings_messages_ai` AFTER INSERT ON `messages`
WHEN (SELECT `semantic_search_enabled` FROM `app_settings` LIMIT 1) = 1
	AND new.`mailbox_id` IS NOT NULL
	AND new.`status` IN ('received', 'sent', 'archived')
	AND (new.`spam_verdict` IS NULL OR new.`spam_verdict` <> 'spam')
	AND NOT coalesce((SELECT `ai_disabled` FROM `mailbox_agent_settings` WHERE `mailbox_id` = new.`mailbox_id`), false)
BEGIN
	INSERT OR IGNORE INTO `message_embeddings` (`message_id`, `mailbox_id`, `status`, `queued_at`)
	VALUES (new.`id`, new.`mailbox_id`, 'pending', CAST(strftime('%s', 'now') AS integer));
END;--> statement-breakpoint
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
	ON CONFLICT(`message_id`) DO UPDATE SET `status` = 'pending', `queued_at` = CAST(strftime('%s', 'now') AS integer), `lease_until` = NULL
	WHERE `message_embeddings`.`status` = 'skipped';
END;--> statement-breakpoint
-- The state table has no foreign key to `messages` so that this trigger can still read it; it runs for every
-- message, not only indexed ones, which costs nothing when there is no matching row.
CREATE TRIGGER `message_embeddings_messages_ad` AFTER DELETE ON `messages` BEGIN
	INSERT INTO `message_embedding_deletes` (`vector_key`, `chunk_count`, `created_at`)
	SELECT `vector_key`, `chunk_count`, CAST(strftime('%s', 'now') AS integer) FROM `message_embeddings` WHERE `message_id` = old.`id`;
	DELETE FROM `message_embeddings` WHERE `message_id` = old.`id`;
END;
