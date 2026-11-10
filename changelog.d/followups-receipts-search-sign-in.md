### Fixed

- Keep receipts: a receipt is no longer saved twice when you press "Save receipts for existing payments" while one is being filed, every account gets its turn in the background filing, and the dialog counts the receipts that still could not be saved.
- Search by meaning: indexing of old mail now counts against its own share of the daily spend limit. This needs a database update, applied from the [Admin overview](/admin) as described in the [update instructions](https://github.com/midego1/kite/blob/main/docs/deployment.md#updating-kite). A failed switch-on for a mailbox stays off.
- Cold storage: two rule saves in the same second can no longer overwrite each other, and a stranded move is cleaned up before a new one starts.
- Sign in with Microsoft: a tenant given as a domain stays tied to the tenant of its first sign-in, and switching a connected account to a password can no longer be overwritten by a token refresh that was already running.
- Phishing check: a tracked link whose destination is only readable after unescaping is no longer trusted just because it looks like the shown site.
