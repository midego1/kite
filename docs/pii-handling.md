# Personal data and evidence handling

Mail contents, subjects, sender/recipient addresses, attachments, contacts,
calendar/booking details, agent conversations, audit records and avatars may
identify a person. API keys, session tokens, MFA material and provider secrets
are confidential even when not personal data.

## Storage and scope

See [Privacy and data handling](privacy.md) for what is stored where, retention, export and deletion.

Money Watch adds two per-user tables (`src/db/schema/finance.ts`, migration
0063): `finance_subscriptions` (vendor, plan, amounts, dates, status, the
`List-Unsubscribe` cancel link and links to messages, contact, mailbox and the
calendar reminder) and `finance_charges`, the document ledger (type, amount,
dates and period, source message and attachment id per invoice, payment, credit
note, refund or failed payment). The ledger holds attachment references only,
never file content or extracted PDF text. Both are owner-only in every surface
(page, API, search, refs, tools, webhooks), are backed up in the `mail` group,
cascade from the user row, keep the amounts but lose the message and attachment
links when a message is deleted, and are kept when the module is turned off.
Logs carry only ids and codes for them, never vendors, amounts, dates or URLs.

Usage statistics are off unless the owner turns them on under Admin → General
(`src/lib/telemetry/`, migration 0071). They are pseudonymous, not anonymous:
the daily heartbeat holds a random install id, the Kite version, the runtime,
the ranges (never exact numbers) of accounts, active accounts, mailboxes and
messages, and the modules that are on; never ids, addresses, domains,
`APP_URL` or error text. It goes to `kite-telemetry.midego.net`, run by
Michiel de Gooijer (midego) on Cloudflare (data requests: privacy@midego.net),
unless `KITE_TELEMETRY_URL` names another collector or is empty. On Workers,
Cloudflare adds a `CF-Worker` header naming the Worker's zone (the domain or
`workers.dev` subdomain) to the request, which Kite cannot remove; on Node the
collector sees the server's IP address. The collector does not read, log or
store either; daily reports are kept 90 days, then only totals without ids.
Turning statistics off asks the collector to erase the install's reports. `telemetry_state` is not in Kite's backups, but a copy
of the database file or a D1 Time Travel restore carries the same install id.
See [Privacy](privacy.md#usage-statistics-opt-in).

Review [the database schema](../src/db/schema/index.ts), `src/lib/backups/export.ts`, and
`src/lib/backups/table-groups.ts` for the current persisted model. D1/SQLite holds
account and mail metadata plus other records; R2/filesystem holds message and
attachment objects. Backups export database records, including sensitive auth
and configuration tables. Do not assume a JSON backup includes all original
message or attachment objects; review the selected table groups and object
storage before recovery. Treat every backup as confidential.

`APP_ENCRYPTION_KEY` is optional in deployment configuration and protects
selected stored secrets when configured. It does not promise end-to-end mail
encryption or whole-backup encryption. Operators must secure the storage
account, access controls, export destinations and any copied encryption key.

## Development and incident evidence

- Use `example.com` addresses and synthetic MIME/attachments in tests. Never
  copy a production mailbox or database into a Mission environment.
- Keep local evidence in ignored `local-evidence/`. Ignore rules are convenience,
  not access controls. Before attaching anything inspect it for secrets and PII.
- Record operational counts, opaque request IDs, error types, affected revision
  and UTC time windows. Avoid subjects, addresses, body text, raw MIME, attachment
  names, cookies, signed URLs, Authorization headers and exception messages.
- `src/lib/logger.mjs` redacts known sensitive field names and reduces exceptions
  to their type. This is defense in depth: new free-text fields can still leak.
  Review each call site, and never pass mail or credentials as generic metadata.
- CI artifacts must contain only synthetic data. Do not upload production logs
  or scanner reports with raw secrets; the Gitleaks lane uses full redaction.

## Access, export and deletion

Verify the authenticated actor and mailbox authorization before reading,
exporting, restoring or deleting records. Never use an admin-only route as a
shortcut in a user-level feature. Review both session and API-key/MCP paths.
Use the product's supported account deletion/export and retention controls;
check their actual behavior before promising that all copies are removed.

Operators must document deployment-specific retention for trash, backups,
provider stores, audit records, object storage and local exports. Retention
settings and account deletion do not by themselves prove removal from backups,
provider systems or shared artifacts. Restrict access to retained backups;
remove expired copies and document lawful retention exceptions. After restoring
an older backup, reapply any deletion requests that postdate that snapshot.

For a data exposure, follow [the incident runbook](runbooks/incident.md), limit
further access, preserve restricted evidence and have the responsible operator
assess notification obligations. This repository supplies procedures, not a
legal compliance certification or an enabled notification service.
