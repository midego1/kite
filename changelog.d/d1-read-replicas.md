### Changed

- Kite can now read from Cloudflare D1 read replicas near you, so pages can load faster once read replication is switched on for the database, while you still see your own changes at once. It is off until you enable it; see [Operations](https://github.com/midego1/kite/blob/main/docs/operations.md#d1-read-replication). Ported from upstream Mailflare #268.
