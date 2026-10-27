### Changed

- Report spam always asks first, wherever it starts: the reader's toolbar, Move menu and `!` key, a selection in the list, dropping mail on Spam, a conversation's message menu and Mark as spam on the phishing warning. Cancel or Esc does nothing, and there is no "don't ask again".
- Report phishing's question now reads "Report as phishing?".

### Added

- Undo for Report spam and Report phishing, from the toast that follows. It puts the message back where it was and takes back exactly what the spam filter learned from the report, and a phishing report's Undo also unblocks the sender when that report placed the block and reopens the warning it closed. Undoing a move to Spam in the assistant chat or Mark as spam now untrains the filter too. Until the database update is applied, Undo only moves the mail back.
