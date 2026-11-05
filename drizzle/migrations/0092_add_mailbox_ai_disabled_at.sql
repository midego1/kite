-- When "No AI for this mailbox" was last turned on; set only when the switch flips, cleared when it is turned off.
-- The chat stops resending messages from before then. Mailboxes already off take the time of their last "turned on"
-- audit row, or their last settings save when there is none (never earlier than the switch).
ALTER TABLE `mailbox_agent_settings` ADD `ai_disabled_at` integer;--> statement-breakpoint
UPDATE `mailbox_agent_settings` SET `ai_disabled_at` = coalesce((SELECT max(`audit_logs`.`created_at`) FROM `audit_logs` WHERE `audit_logs`.`action` = 'agent.mailbox_ai' AND `audit_logs`.`mailbox_id` = `mailbox_agent_settings`.`mailbox_id` AND `audit_logs`.`metadata` = '{"aiDisabled":true}'), `updated_at`) WHERE `ai_disabled` = 1;
