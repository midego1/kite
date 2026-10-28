### Added

- The admin overview shows the database size against its limit (10 GB on Cloudflare D1; set `D1_MAX_BYTES=500000000` on Workers Free), amber from 70% and red from 90%, and a new operational alert "Database nearly full" fires at 90%.
- [Settings → Import](/settings/import) estimates what an import adds to the database, warns from 70% of the limit and asks for **Import anyway** above 90%. A running import pauses itself at 90% and keeps its saved credentials until you resume it, which asks for confirmation while the database is still full. No migration is needed.

### Fixed

- Self-hosted (Node) installs now report the database size to the app instead of 0.
