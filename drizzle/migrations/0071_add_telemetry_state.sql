CREATE TABLE `telemetry_state` (`id` text PRIMARY KEY NOT NULL, `enabled` integer DEFAULT 0 NOT NULL, `install_id` text, `last_sent_day` text, `updated_at` integer NOT NULL);
