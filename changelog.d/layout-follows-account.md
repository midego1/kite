### Added

- Your reading layout follows your account: the reading pane position, list density, conversation view and the size of the message list are saved to the account and applied in every browser you sign in to, with each browser keeping a copy for a fast start. A browser can keep its own layout instead under [Settings → Inbox → Layout](/settings/inbox). Needs migration `0080_add_user_preferences` (the new `user_preferences` table, included in backups); until it is applied, layouts stay in each browser as before.
