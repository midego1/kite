-- Assistant settings → "No AI for this mailbox": while on, nothing from the mailbox is sent to any AI provider (chat,
-- Write with Kite, summaries, automatic reading). Off by default, so every mailbox keeps working as before.
ALTER TABLE `mailbox_agent_settings` ADD `ai_disabled` integer DEFAULT 0 NOT NULL;
