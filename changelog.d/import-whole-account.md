### Added

- **Import a whole account.** [Settings → Import](/settings/import) → IMAP → **Whole account** lists the account's folders with their message counts and sizes and proposes where each goes: Inbox, Sent and Archive to the same places in Kite, your own folders to Kite folders of the same name (nested ones as `Parent / Child`), Spam and Trash offered but unticked, Drafts left out. Every row can be changed. One background job then copies the folders one after another; a message in two folders lands once.
- On Gmail, All Mail is copied once and each message is filed by its labels (Inbox, else Sent, else its first label as a Kite folder, else Archive), so labels no longer import the same message several times.
- Imports can be paused and resumed from the jobs list, which now shows each folder's progress. A paused import keeps its place and its saved password for up to seven days.
- Apply database migration 0075 after deploying, from the database card on the admin overview or the banner in the mailbox. It adds the folder list of whole-account imports; until it is applied, only one-folder imports can start.

### Changed

- The IMAP import form's **One folder** mode replaces the earlier choice of sections, which started one background job per folder.
