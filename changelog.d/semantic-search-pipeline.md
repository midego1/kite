### Added

- **Search by meaning, indexing**: the primary admin can turn on indexing under [Admin → Agent](/agent#semantic-search), which prepares mail to be found by what it means, not only its exact words, with progress and pausing shown there. Searching by meaning itself arrives in a later release; until then turning this on only builds the index, and sends mail text to the embedding provider. A mailbox manager can leave their own mailbox out. Off by default; needs a database update. **Before you deploy this release**, a Cloudflare-hosted install must create a search index once, or the deploy fails. See [the docs](https://github.com/midego1/kite/blob/main/docs/deployment.md#search-by-meaning-optional) for the exact steps.
  ![Admin → Agent → Search by meaning, partway through indexing with progress, pause and rebuild controls](/changelog/2026-11-08-semantic-search-admin-light.webp)
  <!-- changelog-style: technical-ok -->
