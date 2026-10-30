### Added

- Direct Drive uploads to R2 are now part of setup on Cloudflare: creating the first admin account uses `CF_TOKEN` to create an API token that may only read and write the `kite-raw` bucket, sets the bucket's CORS rule for the app, checks and saves the keys. Add the account permissions **Workers R2 Storage: Edit** and **Account API Tokens: Edit** to `CF_TOKEN` for this (see [Direct uploads at setup](https://github.com/midego1/kite/blob/main/docs/deployment.md#direct-uploads-at-setup)); you may remove the second after setup. If it cannot, setup still finishes.
- [Admin → Storage](/storage) and the [Admin overview](/admin) show "Direct uploads are off: set up (2 min)", with why the automatic setup failed, until direct uploads are on or the reminder is dismissed. **Enable direct uploads** starts with **Set up automatically**, which does the same in one click and names a missing permission; the guided manual steps stay below it.
- Migration 0085 adds the `storage_state` table, which keeps the automatic setup's outcome and the dismissed reminder. Apply it from the database update banner or the [Admin overview](/admin); until then the reminder shows without a reason and **Dismiss** waits for the update.
- **Add store** with Cloudflare R2 can create a new R2 bucket (with a suggested name, location and jurisdiction) or connect one picked from the account's buckets in one click, listing each step as it goes. A taken name offers to connect the existing bucket. Kite adds its CORS rule next to the bucket's other rules, and puts the policy back if the setup fails.

### Changed

- Requests to a saved store no longer follow HTTP redirects (this came with the Test connection hardening): a store behind a proxy that redirects must be saved with its final endpoint.
- A Test connection attempt refused by the limit keeps its single audit row, now marked `outcome: "rate_limited"`, and every attempt's row records its outcome.

### Security

- `CF_TOKEN` needs **Account API Tokens: Edit** for the automatic setup, which lets it create other tokens; Kite only uses it when setup runs or an admin selects Set up automatically or Create bucket and connect, and the docs and the dialog recommend removing it afterwards. The token value and the derived S3 secret are never stored in clear, returned or logged.
