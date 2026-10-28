-- Large HTML bodies of imported mail live in the Mail store at `bodies/<message id>.html`, recorded here, with
-- `html_body` left null. The text body stays in the row for search, snippets and automatic reading. `body_size` is
-- the UTF-8 size of the bodies as imported (text part plus HTML), so JMAP's size filters and sort match Email/get
-- without reading the object; it is set only for offloaded rows.
ALTER TABLE `messages` ADD `html_body_key` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `body_size` integer;
