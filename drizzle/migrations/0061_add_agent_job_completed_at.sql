ALTER TABLE `agent_jobs` ADD `completed_at` integer;--> statement-breakpoint
UPDATE `agent_jobs` SET `completed_at` = `created_at` WHERE `status` = 'completed';
