### Added

- [Settings → Import](/settings/import) now shows how big each folder of an account is and, under the list, the totals: how many messages, how much mail that is, and how much the import adds to mail storage and to the database. Kite measures the sizes while you look, so you can start the import at any time.
  ![The folder list of a whole-account import with each folder's size and the totals the import adds](/changelog/2026-11-05-import-sizes-light.webp)
- When you connect an account you can choose **New mailbox for this account**. Kite suggests a name from the address (jane.demo@gmail.com becomes jane.demo-gmail), creates the mailbox and connects the account to it. If connecting fails, Kite tells you which mailbox it made and lets you use it again or delete it.
  ![The Connect an account dialog with a new mailbox name filled in](/changelog/2026-11-05-new-mailbox-light.webp)
- Importing mail from a connected account now starts in the mailbox that account's mail goes to.

### Fixed

- The import's estimate of mail storage no longer counts every attachment twice: imported mail takes about as much space as the mail itself. The database warning also uses the real folder sizes instead of a guess.
