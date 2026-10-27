### Added

- Apply database migration 0070 after deploying, from the database card on the admin overview or the banner in the mailbox. It adds the `telemetry_state` table for anonymous usage statistics; until it is applied, they stay off and [Admin → General](/general) asks for the update.
- Anonymous usage statistics, **off by default**. The owner can turn them on under [Admin → General](/general). Kite then sends one small report a day, around 02:00 UTC: a random install ID made when statistics are turned on, the Kite version, Workers or Node, how many accounts, active accounts and mailboxes there are, how many messages came in and went out in the last day, and which modules are on. It never contains names, email addresses, domains, IDs, `APP_URL` or message content; on Cloudflare Workers, Cloudflare itself adds a header naming the Worker's zone to the request, which the collector ignores. The card lists every field, and turning statistics on or off is listed under [Admin → Activity](/activity). Turning statistics off deletes the install ID. Operators can set `KITE_TELEMETRY=0` to keep them off whatever the owner chooses, and `KITE_TELEMETRY_URL` to send them to another collector instead. Reports go to `kite-telemetry.midego.net`, run by the Kite maintainer on Cloudflare. Nothing is sent at setup. See [Privacy](https://github.com/midego1/kite/blob/main/docs/privacy.md#usage-statistics-opt-in).

### Changed

- The privacy statement in the README and the privacy page now describe the opt-in usage statistics instead of saying Kite has no telemetry.
