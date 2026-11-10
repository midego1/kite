### Fixed

- The reader toolbar uses the room it has: a wide Reply all no longer pushes every icon into More actions, an error message next to the toolbar stays readable, and Move to in More actions is disabled on read-only shared mail like the Move button.
  ![The reader toolbar before (Summarize, More actions and Delete only) and after (Archive and Snooze shown too)](/changelog/2026-11-10-reader-toolbar-icons-light.webp)
- The Unverified sender badge stays fully visible next to a long sender name on a phone, screen readers read it in the conversation, and a Reply-To on a subdomain of the sender's own domain is no longer called a different domain. Opening a message no longer waits long on a slow contact check.
  ![The sender line of an open message at phone width, before (badge cut off) and after (name shortened, badge visible)](/changelog/2026-11-10-sender-badge-narrow-light.webp)
- In a narrow message list the selected count keeps its number ("975 selected" never shows as "97…"), and switching the interface to Arabic keeps the messages you checked.
- The assistant's search can now page through results, and it no longer skips mail that arrived in the same second as the last result on the previous page.
- Adding a sixth extra address for the assistant by email now says you are at the limit instead of "a code was sent", and a settings save that needs a pending database update changes nothing instead of saving part of it.
- Keep receipts: the delete prompt says an entry may have saved copies in Drive, and the existing-payments dialog says to run it again to retry receipts that could not be saved.
