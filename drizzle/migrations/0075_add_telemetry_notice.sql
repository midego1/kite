ALTER TABLE `telemetry_state` ADD `decision` text;--> statement-breakpoint
ALTER TABLE `telemetry_state` ADD `start_day` text;--> statement-breakpoint
ALTER TABLE `telemetry_state` ADD `notice_dismissed` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `telemetry_state` SET `decision` = CASE WHEN `enabled` = 1 THEN 'on' ELSE 'off' END;
