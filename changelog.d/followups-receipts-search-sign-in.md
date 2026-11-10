### Fixed

- Keep receipts: a receipt is no longer saved twice when you press "Save receipts for existing payments" while one is being filed, every account gets its turn in the background filing, and the dialog counts the receipts that still could not be saved.
- Search by meaning: indexing of old mail is counted against its own share of the daily spend limit by how it was queued, not by how old the mail is. This needs a database update applied from the [Admin overview](/admin). If turning it on for a mailbox fails, it stays off and is not logged as on, and the share field shows the saved value.
- Cold storage: two rule saves in the same second can no longer overwrite each other, and a stranded move is cleaned up before a new one starts.
- Sign in with Microsoft: a tenant given as a domain stays tied to the tenant of its first sign-in, and switching a connected account to a password can no longer be overwritten by a token refresh that was already running.
- Phishing check: a tracked link whose destination is only readable after unescaping is no longer trusted just because it looks like the shown site.
