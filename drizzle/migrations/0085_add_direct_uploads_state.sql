-- Direct uploads by default: what the install-time (or one-click) R2 setup last did, and whether the owner dismissed
-- the "Direct uploads are off" reminder. A table of its own rather than an app_settings column, so code deployed
-- before this migration keeps writing app_settings. One row, id 'default'; JSON, never a key.
CREATE TABLE `storage_state` (`id` text PRIMARY KEY NOT NULL, `direct_uploads` text, `updated_at` integer NOT NULL);
