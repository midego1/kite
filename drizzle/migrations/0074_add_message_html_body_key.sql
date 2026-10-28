-- Large HTML bodies of imported mail live in the Mail store at `bodies/<message id>.html`, recorded here, with
-- `html_body` left null. The text body stays in the row for search, snippets and automatic reading.
ALTER TABLE `messages` ADD `html_body_key` text;
