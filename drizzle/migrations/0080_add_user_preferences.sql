CREATE TABLE `user_preferences` (`user_id` text PRIMARY KEY NOT NULL REFERENCES `users`(`id`) ON DELETE cascade, `layout` text DEFAULT '{}' NOT NULL, `updated_at` integer NOT NULL);
