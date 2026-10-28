-- What happened to each AI request, for Admin → AI usage: `status` (`ok`, `failed` or `stopped`), the shared AI error
-- code of a failure, the time from the reservation to its settlement, the provider's finish reason and the USD-per-1M
-- rates the cost was counted at. Rows from before this migration keep them null and show as not recorded.
ALTER TABLE `ai_usage` ADD `status` text;--> statement-breakpoint
ALTER TABLE `ai_usage` ADD `error_code` text;--> statement-breakpoint
ALTER TABLE `ai_usage` ADD `duration_ms` integer;--> statement-breakpoint
ALTER TABLE `ai_usage` ADD `finish_reason` text;--> statement-breakpoint
ALTER TABLE `ai_usage` ADD `input_rate` real;--> statement-breakpoint
ALTER TABLE `ai_usage` ADD `output_rate` real;
