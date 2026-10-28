### Security

- Drafts are now private to their author in shared mailboxes. Another person with access to the mailbox, its owner and administrators included, no longer sees your drafts in Drafts, counts, search, mailbox export, the REST API or JMAP, and opening one of them or its attachments by link answers "not found".
- A draft now leaves Drafts only by being sent or deleted. **Delete** in Drafts removes drafts at once with their attachments (after asking, without Undo) instead of moving them to Trash, Drafts no longer offers Archive, Report spam or Move to, and the server and JMAP refuse to move a draft elsewhere or a message into Drafts.
- Removing a member from a shared mailbox deletes their drafts in it.
