### Added

- **New mail from connected accounts.** Kite now checks each [connected account](/settings/connected-accounts)'s Inbox for new mail every 5 minutes (or every 15 or 60, per account) and delivers it into the account's mailbox like mail Kite receives itself: spam filter, mailbox rules, the Screener, notifications, webhooks (`message.inbound` with `source: "external"` and the `accountId`) and automatic reading. Mail already read or starred at the provider arrives read or starred and without a notification; a message Kite already has (same Message-ID) is not stored twice; nothing at the provider is changed. **Check now**, **Pause**/**Resume** and the interval are on each account, which also says when it was last checked. A failed sign-in, an invalid certificate or a server that cannot be reached shows on the account and in a sidebar notice with **Reconnect**; throttled and unreachable servers are retried with backoff (at most every 6 hours). For Gmail and Google Workspace accounts Kite trusts Google's own `Authentication-Results` header for the spam filter. Checking runs on the existing cron and agent queue, on Workers and on the Node server.

### Changed

- An **Other IMAP provider** account names its own server, so its sign-in does not prove the address. Such an address no longer claims the address for the whole install, and connecting one never says whether the address is already connected elsewhere; addresses at the known providers stay unique. Apply database migration **0080** (`0080_external_account_address_scope.sql`) from the admin overview.

### Fixed

- A restore no longer fails on a foreign key when a message names a connected account the backup does not contain (an account connected while the backup was being written): the message is restored without it.
