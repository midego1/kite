-- Whether a folder's colour was picked by a person (the create dialog, the assistant) instead of being the default
-- blue, which the icon rail needs to tell a chosen blue from no choice. Existing folders stay "not custom".
ALTER TABLE `folders` ADD `color_is_custom` integer DEFAULT 0 NOT NULL;
