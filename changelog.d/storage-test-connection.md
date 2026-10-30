### Added

- [Admin → Storage](/storage): **Test connection** in the Add store, Edit store and Enable direct uploads dialogs runs every check (endpoint, credentials, bucket, write, read, list, delete, multipart, signed link, CORS) without saving, and lists each with ✓ or ✗ and a fix in the provider's own words; a missing CORS rule comes with the rule for this site and a **Copy** button.
- The store form is grouped into Where, Credentials and Direct uploads, with provider presets: Cloudflare R2 asks only for the account ID, Amazon S3, Backblaze B2, Wasabi and Hetzner pick a region and build the endpoint, and each provider links to the page that creates its keys. The secret has a show and hide toggle, and mistakes are explained under the field.
- **Enable direct uploads** for the default R2 bucket is a four-step guide (create the token, paste the keys and account ID, test, save), and the Storage page and [Drive settings](/drive/settings) recommend it while Drive uploads still pass through the Worker.

### Changed

- A saved store's check list folds into "All N checks passed · Checked <time>" with **Show details** when nothing failed, and the **Switch** button under Where data lives explains why it is unavailable.
- A refused access key or secret now says which one and why (a space or line break, or its length), instead of "That does not look like an access key pair".
