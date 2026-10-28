# Spec: external mail accounts (ROADMAP Milestone 6)

Status: accepted by Michiel on 2026-10-27 (see [Decisions](#18-decisions-2026-10-27-michiel)); ready to build. Written against `main` at `d7810f9`; every path is relative to the repository root. Migration numbers are left open: the last migration on `main` is `0070_add_writing_style.sql`, so this work starts at the next free number when each PR is built, keeping `tests/migration-order.test.mjs` passing. Scope: [ROADMAP Milestone 6](../../ROADMAP.md#milestone-6-external-mail-accounts), phases 1 to 3 in full, and phase 4 (OAuth) designed here but sized and approved separately.

## 1. Summary

Bring a user's existing mail from Gmail, iCloud, Fastmail, Yahoo and other IMAP providers into Kite, keep new mail arriving, and reply from the same address.

1. **Better import.** One job copies the whole account (every folder), keeps read and starred state, maps the provider's folders onto Kite's statuses and folders, shows progress per folder, pauses and resumes, and skips what Kite already has by Message-ID. Before it starts, it estimates what it will add to the database and warns before D1's 10 GB limit comes close. It runs on Workers and on the Node/Docker runtime.
2. **Keep new mail arriving.** A *connected account* stores its credentials (sealed) and is checked every 5 minutes for new INBOX mail by IMAP UID. Synced mail goes through the same delivery pipeline as mail Kite receives itself: spam filter, mailbox rules, Screener, notifications, webhooks and automatic reading.
3. **Send as the external address.** The composer's From menu offers the connected address, and mail goes out through the provider's own SMTP submission server, so it carries the provider's SPF and DKIM. A copy lands in Kite's Sent folder and, where the provider does not save one itself, in the provider's Sent folder.
4. **OAuth for Microsoft and Google** (designed, sized separately). Sign in with the install's own app registration, store refresh tokens sealed, and authenticate IMAP and SMTP with XOAUTH2. This is the only way to reach Outlook.com and Microsoft 365.

Design principles:

1. **Kite is where the mail lives; the provider is a source, not a mirror.** Kite never deletes, moves or marks anything at the source. The only write to the source is the optional Sent copy (§7.4).
2. **One delivery pipeline.** Synced mail enters the existing inbound pipeline (`processInboundMessage`), not a second copy of it, so every rule that holds for received mail (statuses, Screener, spam, threading, webhooks) holds for synced mail.
3. **One protocol stack on both runtimes.** IMAP and SMTP are spoken by our own small clients over a socket adapter that is `cloudflare:sockets` on Workers and `node:net`/`node:tls` on Node (§8).
4. **Long-lived credentials are explicit, sealed and removable.** A one-time import keeps erasing its password when it ends. Only a connected account stores credentials, only when `APP_ENCRYPTION_KEY` is set, and removing the account deletes them.

Non-goals: two-way sync (the roadmap's "not planned"), POP3, Proton Mail Bridge, Exchange EWS or Microsoft Graph mail APIs, syncing folders other than INBOX (and optionally Spam) after the import, and calendar or contacts sync.

## 2. What exists today

| Area | Where | Relevance |
| --- | --- | --- |
| IMAP client | `src/lib/import/imap.ts` (`ImapConnection`: greeting, `LOGIN`, `EXAMINE`, `UID SEARCH ALL`, `UID FETCH (UID BODY.PEEK[])` in chunks of 25, `LIST "" "*"`), `imap-utils.ts` (quoting, literal parsing, UID batching, `assertSafeImapHost`) | Works, but reaches the network through a dynamic `import("cloudflare:sockets")`, so it throws "IMAP import requires the Cloudflare Workers socket runtime" on Node. `secure: false` sends `LOGIN` in plain text on port 143. No `CAPABILITY`, `STARTTLS`, `AUTHENTICATE`, flags, sizes or special-use attributes. |
| Background import jobs | `src/lib/import/jobs.ts`, `import_jobs` (migration 0054, `src/db/schema/import-jobs.ts`) | One folder per job, newest first, 200 messages per run (`MESSAGES_PER_RUN`), 5-minute run budget, 8-minute lease, `cursorUid` = lowest UID done, 5 attempts. Jobs for the same `host` + `username` run one at a time. The sealed password is erased when the job completes, fails or is cancelled. `import.imap` messages ride `AGENT_QUEUE`. |
| Module wiring | `src/lib/modules/import/` (manifest: page `/settings/import`, API `/api/import`, queue type `import.imap`, cron task `resumeStalledImports`, grant `import.run`), `src/lib/import/background.ts` | Mail import is a module. Its jobs pause, untouched, while it is off for the install or the owner, and resume from the cron task. |
| Write path | `moduleHost.mail.importMessages` → `importModuleMessages` (`src/lib/email/module-import.ts`) → `importMessagesToMailbox` (`src/lib/import/service.ts`) | Parses with `parseRawMime`, skips by `providerMessageId` per mailbox (one lookup per batch), falls back to `import:<filename>:<size>` when there is no Message-ID, writes the row, the raw MIME at `imports/<messageId>.eml`, attachments and the contact. **Inbound imports are always unread and never starred** (`read: placement.direction === "outbound"`). No spam analysis, no Screener, no webhooks, no notification, no automatic reading. |
| Destinations | `src/lib/import/destination.ts` | `system:inbox|sent|drafts|archived|spam|trash` or `folder:<id>`; sent and drafts are outbound and owned by the importing user. |
| Threading | `resolveThreadId` (`src/lib/email/threading.ts`) | A message joins the thread of a *stored* parent; otherwise its own Message-ID seeds a thread. Because imports run newest first, a reply is usually stored before its parent, so an imported conversation splits into several threads. |
| Inbound pipeline | `processInboundMessage` (`src/lib/email/inbound.ts`) | Resolves the recipient through domain routing, then: parse, attachment limits, mailbox rules (`resolveInboxRuleDestination`), `analyzeSpam`, `applyScreener`, contact, thread, insert (idempotent on `raw_r2_key`), attachments, reputation, `announceDelivery` (notification and auto-reply), `dispatchWebhooks("message.inbound")`, `scheduleAgentWork`. Authentication signals come only from `payload.authenticationResults`, set by a trusted intake hop. |
| Sending | `send.ts`, `getAuthorizedSenderAddress` (`sender.ts`, From must be one of `getMailboxDomainAddresses`), `getOutboundProviderConfig` and `sendThroughProvider` (`outbound-provider.ts`, provider chosen by the From **domain**: Cloudflare, Resend or SES), `outbound_jobs` for scheduled and undoable sends | Structured messages; there is no MIME builder in the codebase. Nothing can send from an address outside a Kite domain. |
| SSRF guards | `isBlockedHost` (literal check, `src/lib/security/outbound-url.ts`), `assertPublicHttpUrl` (also resolves through `env.RESOLVE_HOST`, set only on Node by `server/runtime/env.ts`), `assertStoreEndpoint` (`src/lib/storage/config.ts`, checked on save and on every config load) | IMAP uses only the literal check today: on Node a public name that resolves to a private address is not caught. |
| Secrets | `sealSetting`/`openSetting` (`src/lib/security/secret-box.ts`, AES-GCM, HKDF from `APP_ENCRYPTION_KEY`) | Without a key, `sealSecret` stores plain text. Storage credentials refuse to save without a key; this spec does the same for connected accounts. |
| Database size | Nothing measures it. `server/runtime/sqlite-database.ts` reports `size_after: 0`. | Needed for the estimate and the warning (§5). |
| Test fakes | `scripts/agent/fake-model-server.mjs`, `e2e/support/fake-model.ts`, `e2e/support/fake-abuse-ch.ts`, the fake S3 for `e2e/48-storage-s3.spec.ts`; `smtp-server` and `nodemailer` are already dependencies (Node SMTP listener and Node `EMAIL`) | **There is no fake IMAP or SMTP submission server.** `e2e/27-modules.spec.ts` only checks the IMAP routes' module guard and a refused host. |

### 2.1 What is stored where

| Data | Where | Per message (rough) |
| --- | --- | --- |
| Header columns, snippet, spam signals, thread keys | D1 `messages` | 1–2 KB |
| `text_body` and sanitized `html_body` | D1 `messages` | text a few KB; HTML often 10–60 KB for newsletters and receipts |
| Full-text index over subject, addresses, `text_body` and `html_body` | D1 `messages_fts` (external content, so the text is not stored twice, but the index is) | roughly a third to a half of the indexed text |
| Attachment metadata | D1 `message_attachments` | < 1 KB per attachment |
| Raw MIME | Mail store (R2 or S3, `src/lib/storage/`): `inbound/…`, `imports/<id>.eml`, `drafts/<id>.eml` | the full message, attachments included |
| Attachment bytes | Mail store, `attachments/<messageId>/<id>/<filename>` (a second copy of what the raw MIME holds; [storing attachments once](attachments-once.md) removes it) | decoded size |

So the HTML body is stored twice (D1 and inside the raw MIME) and is usually the largest D1 cost of a message. A 100,000-message mailbox at 30–60 KB of D1 per message is 3–6 GB, a large part of the 10 GB D1 limit on Workers Paid (500 MB on Workers Free). That is what §5 measures, warns about and, for imported and synced mail, avoids.

## 3. Decisions

| # | Question | Decision | Why |
| --- | --- | --- | --- |
| D1 | Where does an account's mail go? | Into a Kite mailbox the owner chooses (default: their personal mailbox), tagged with `messages.external_account_id`, shown as a "via Gmail" chip and filterable. Not a mailbox of its own. | `mailboxes.domain_id` is `NOT NULL` and every mailbox path (routing, sender addresses, DNS, Cloudflare rules) assumes a Kite domain. A synthetic domain for `gmail.com` would let the SMTP listener and relay route mail for it. Accepted. |
| D2 | Import, sync and send-as: module or core? | The one-time import stays in the **Mail import module**. Connected accounts, sync and send-as are **core**, in `src/lib/external-accounts/`, with the protocol clients in core `src/lib/imap/`, `src/lib/smtp/` and `src/lib/net/`. | Sync is a receiving provider and send-as a sending provider. Both run inside core surfaces that may not import module code (`worker.ts`, the inbound pipeline, `send.ts`, `outbound_jobs`, the composer). Turning a module off must not leave a mailbox half-receiving or a scheduled send without a transport. §9. |
| D3 | Spam filter and Screener on synced mail | **Both apply**, exactly as for received mail. The provider's `Authentication-Results` is trusted only for known providers whose header can be tied to their own hop (§6.6). Imported mail is never filtered or screened. | A Screener that unknown senders bypass by writing to the Gmail address is not a Screener, and the user's own training, blocked senders and phishing checks are the point of reading mail in Kite. History is already "decided" by the user. |
| D4 | Automatic reading | **Synced mail: yes**, through `scheduleAgentWork` with the usual gates and the mailbox's daily limit. **Imported mail: never.** | Synced mail is new mail. Running the model over years of history would cost money and fill For you with stale suggestions. |
| D5 | Deletes and moves at the source | Ignored. Kite fetches each new INBOX message once and never looks back. | Principle 1. A two-way mirror needs a held connection Workers cannot keep and per-provider conflict rules (roadmap, "not planned"). |
| D6 | IDLE | Not used. Polling every 5 minutes (the cron tick), with **Check now**. | §6.2. |
| D7 | Sending as the external address | Through the provider's SMTP submission server only, never through Kite's Cloudflare, Resend or SES sending. | §7.1. |
| D8 | Sent copy at the source | Appended with IMAP `APPEND` when the provider does not save SMTP submissions itself (preset), with a per-account switch. | Keeps the provider's Sent folder complete for the user's phone and for leaving Kite, at the cost of one write. Accepted. |
| D9 | Credentials without `APP_ENCRYPTION_KEY` | Connecting an account is refused. The one-time import keeps working as today. | A mailbox password stored for months in plain text is not acceptable; import holds it for minutes. |
| D10 | Plain-text IMAP and SMTP | Removed, imports included (a `### Security` changelog entry ships with the PR that does it). Implicit TLS (993, 465) or `STARTTLS` (143, 587) with certificate verification, no "ignore certificate" option. A loopback-only dev flag exists for the fakes. | `secure: false` sends the password in clear text today. |
| D11 | Socket adapter | `env.TCP_CONNECT`, a function with the `cloudflare:sockets` `connect()` shape. Unset on Workers (the code falls back to `cloudflare:sockets`); set by `server/runtime/env.ts` on Node with DNS pinning. | Mirrors `env.RESOLVE_HOST`. One client implementation on both runtimes. §8. |
| D12 | Message bodies of imported and synced mail | HTML bodies above 16 KB go to the Mail store (`bodies/<messageId>.html`), not D1; `text_body` stays in D1 for search, snippets and AI. | §5.3. Ships in phase 1 (PR 5). |

## 4. Phase 1: better import

### 4.1 Whole account in one job

A job now has a **scope**: `folder` (today's behaviour, kept for the API) or `account`. An account job lists the source folders once (`LIST "" "*" RETURN (SPECIAL-USE)` where `SPECIAL-USE` or `LIST-EXTENDED` is advertised, otherwise plain `LIST` and the `\Sent`-style attributes that come back anyway), and creates one `import_job_folders` row per folder it will copy (§10.2). Folders run one after another on the same per-account lease, so the provider sees one connection, as today.

Folder mapping (`src/lib/import/folder-mapping-utils.ts`, pure):

| Source folder | Kite destination | Default |
| --- | --- | --- |
| `INBOX` | `system:inbox` (`received`) | on |
| `\Sent` | `system:sent` (outbound, owned by the importing user) | on |
| `\Archive` | `system:archived` | on |
| any other folder without a special-use flag | `folder:<id>`, a Kite folder of the same name, created in the target mailbox if missing; nested names are flattened as `Parent / Child` (Kite folders are flat) | on |
| `\Junk` | `system:spam` | off |
| `\Trash` | `system:trash` (trash retention will purge it) | off |
| `\Drafts` | skipped (old provider drafts are not Kite drafts) | off, not offered |
| `\All`, `\Flagged`, `\Important` (virtual) | skipped, except Gmail below | — |

Order: `INBOX`, `\Sent`, `\Archive`, user folders alphabetically, `\Junk`, `\Trash`. With Message-ID dedupe (§4.3), a message filed in two folders lands once, in the first.

**Gmail** is detected by the `X-GM-EXT-1` capability. Gmail exposes labels as folders, so the same message appears in `INBOX`, `[Gmail]/All Mail` and every label folder. An account job on Gmail imports `[Gmail]/All Mail` once and fetches `X-GM-LABELS` with each message:

- label `\Inbox` → `received`; else `\Sent` → `sent`; else the first user label (alphabetically) → its Kite folder; else `archived`. A message with several user labels gets one folder (Kite has one folder per message); the import summary says how many did.
- `[Gmail]/Spam` and `[Gmail]/Trash` are not in All Mail and are offered separately (off by default).
- Gmail's `\Draft` messages are skipped.

The user sees the mapping as a table before starting (checkbox, source folder, message count, size, destination dropdown) and can change any row. Destinations are validated like today (`parseImportDestination`).

### 4.2 Read and starred state

Each fetch becomes `UID FETCH <uids> (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[])` (plus `X-GM-LABELS` on Gmail). `BODY.PEEK[]` still never sets `\Seen` at the source.

- `\Seen` → `read`; `\Flagged` → `starred`; `\Answered` and keywords are ignored. Outbound rows stay read.
- `INTERNALDATE` becomes `created_at` when the message has no usable `Date` header (today it falls back to "now").
- `HostImportMessage` (`src/lib/modules/host-types.d.ts`) gains optional `read`, `starred` and `receivedAt`, so the module passes them through `moduleHost.mail.importMessages`; mbox and eml uploads leave them unset and keep today's behaviour.

### 4.3 Dedupe by Message-ID

- The key stays `messages.provider_message_id` per mailbox, but the lookup compares **with and without angle brackets** (`normalizeMessageId`, as the JMAP `header` filter does), because inbound rows store brackets and outbound rows do not. Otherwise a Sent message Kite sent itself is imported again from the provider's Sent folder.
- A message without a Message-ID is keyed `import:sha256:<hex of the raw bytes>` instead of `import:<filename>:<size>`, so a re-run, a second folder or a changed UIDVALIDITY recognises it.
- Dedupe holds across the import, sync (§6.4) and earlier imports. Re-running a whole-account import is safe and only adds what is missing.

### 4.4 Threading of imported mail

Imports run newest first, so replies are stored before their parents and conversations split. For imported (and synced) messages, `resolveThreadId` gets a `fallback: "references-root"` option: when no parent is stored, the thread key is the first Message-ID in `References` (else `In-Reply-To`, else the message's own). Parent and replies then converge on the root's id whatever the order. Received mail keeps today's behaviour; it is not switched for now (decision 8); measure on real mail first.

### 4.5 Progress, pause and resume

- Progress per folder (`total`, `processed`, `imported`, `skipped`, bytes) and for the job, polled by the existing jobs panel (`src/components/settings/import-jobs-panel.tsx`) every few seconds while a job is active.
- **Pause** sets `status = 'paused'` and keeps the sealed password, the per-folder cursors and the lease free; **Resume** sets it back to `pending` and enqueues it. **Cancel** works as today and erases the password.
- A job also pauses itself, with a `pause_reason`, when the database crosses the stop threshold (§5.2) or when the module is turned off (today's behaviour, now visible as "Paused: Mail import is off").
- A paused job keeps its sealed password. To bound that, a job paused for more than 7 days is cancelled by `resumeStalledImports` (password erased, reason shown); the user starts it again and dedupe skips what is done.

### 4.6 Runtime

The job, the IMAP client and the delivery path are the same code on Workers and Node. Only the socket differs (§8). The Workers budget of a run stays 200 messages and 5 minutes; Node uses the same numbers so behaviour matches, and its in-process queue simply runs the next batch sooner.

## 5. Database size: estimate, warning and offload

### 5.1 Measuring

`getDatabaseSize(env)` (`src/lib/db/size.ts`) returns `{ usedBytes, limitBytes | null }`:

- D1: `meta.size_after` of a trivial statement on the raw binding (documented on every D1 result). `limitBytes` = `D1_MAX_BYTES` env var when set, else 10 GB (Workers Free installs set `D1_MAX_BYTES=500000000`; the admin overview says so).
- Node: `PRAGMA page_count` × `PRAGMA page_size`, which also fixes `size_after: 0` in `server/runtime/sqlite-database.ts`. `limitBytes` is null (SQLite has no such cap); the estimate is still shown, with free disk space from `fs.statfs` on the data directory.

### 5.2 Estimate before import

Counting is cheap and needs no bodies: `STATUS <folder> (MESSAGES UIDNEXT UIDVALIDITY)` per folder and `UID FETCH 1:* (UID RFC822.SIZE)` per selected folder (one line per message, about 30 bytes each, so 100,000 messages is about 3 MB on one connection). On Gmail the same is done on All Mail with `X-GM-LABELS`, which also yields the per-label counts for the mapping table.

`estimateImport` (`src/lib/import/estimate-utils.ts`, pure) turns counts and sizes into:

- **Mail store**: the sum of `RFC822.SIZE` × 1.75 (raw MIME plus the decoded attachment copy; 1.0 once attachments are stored once).
- **Database**: messages × the install's average D1 bytes per message (`usedBytes / count(messages)` when the install has at least 1,000 messages, else 40 KB), capped per message at `min(RFC822.SIZE, 128 KB)`; with body offload on (§5.3), the cap drops to 24 KB.

The import page shows, before **Start**: "About 48,000 messages, 6.1 GB of mail. Adds about 1.9 GB to the database (now 3.1 GB of 10 GB) and 10.7 GB to mail storage." Thresholds on the projected database size:

| Projected use | What happens |
| --- | --- |
| below 70% | Nothing extra. |
| 70% to 90% | An amber warning; **Start** still works. |
| above 90% | A red warning; **Start** needs an explicit "Import anyway" checkbox, and the admin overview shows the same warning. |
| actual use crosses 90% while running | The job pauses itself with `pause_reason = 'database_nearly_full'` and the admins get the operational alert. Resuming needs the same confirmation. |

### 5.3 Offloading HTML bodies

For mail written by the import and by sync, `html_body` larger than 16 KB (`BODY_OFFLOAD_BYTES`) is written to the Mail store at `bodies/<messageId>.html` and recorded in a new nullable column `messages.html_body_key`; `html_body` stays null. `text_body` stays in D1 (it is what search, snippets, the reader's plain fallback and automatic reading use); when a message has no text part, `text_body` is filled with `htmlToReadableText(html)` so search still finds it. The FTS triggers need no change: they index what is in the row.

All readers go through one helper, `loadMessageBodies(env, row)` (`src/lib/email/bodies.ts`), which reads the object only when `html_body` is null and `html_body_key` is set. The readers to switch (from `grep -l htmlBody`): the message detail route and cache (`src/app/api/messages/`, `src/lib/messages/detail-cache.ts`), JMAP (`email-objects.ts`, `blobs.ts`), the agent tools and auto-read context (`tools.ts`, `auto-read/triage-context.ts`, `reply-suggestion.ts`, `invite-proposal.ts`), `module-read.ts`, `remote-images/message-access.ts`, `spam/feedback.ts`, quoting a message into a reply or forward (`drafts` routes), and `export/mbox.ts` (which already prefers the raw MIME). `deleteMessageWithObjects` and permanent delete remove the object. The storage router already routes the `bodies/` prefix with the Mail class once `object-classes-utils.ts` lists it.

As built (PR 5): the column is declared as a narrow Drizzle view of `messages` (`src/db/schema/message-bodies.ts`), not on the `messages` table, because Drizzle names every column in whole-row selects and inserts and a deploy runs before its migration; PR 7's `external_account_id` meets the same problem. The loader sets a text body derived from the HTML back to null, so an offloaded message reads exactly like an inline one, and the mbox export reads bodies through it (it does not use the raw MIME). Words only in the HTML part of a message that also has a text part are no longer searchable, a trade-off for keeping the markup out of D1.

Backups: the JSON backup carries `html_body_key` but not the object, like raw MIME and attachments today; a restore without the bucket shows the text body. `docs/operations.md` says so.

Received mail keeps its HTML in D1 for now; moving old bodies of all mail out of D1 is the cold-storage item of Milestone 7, which can reuse `html_body_key`.

## 6. Phase 2: keep new mail arriving

### 6.1 Two ways, forwarding first

1. **Forwarding (documented, no stored password).** The user sets up forwarding at the provider to their Kite address and, optionally, a mailbox rule that files mail whose `To` is the external address. It is real-time and needs nothing new. Gmail asks to confirm forwarding with a code sent to the Kite address, which arrives normally. `docs/external-accounts.md` gives the steps per provider. Its limits: some providers (Microsoft 365 by tenant policy) block forwarding to outside addresses, and SPF fails on forwarded mail, so Kite's spam filter leans on DKIM and ARC.
2. **Sync (a connected account).** Kite checks the account's INBOX itself on a schedule. This is the rest of this section.

### 6.2 Why polling and not IDLE

IDLE needs one TCP connection held open per account, indefinitely. On Workers a queue or cron invocation ends after minutes, and a Durable Object holding an outbound TCP socket cannot hibernate (only WebSockets do), so it would bill wall-clock duration for every account around the clock and need its own reconnect logic. A 5-minute poll that usually ends after one `EXAMINE` is cheaper and simpler. On Node a long-lived connection is possible; IDLE there could later trigger an early sync through the same code path, but it is not part of phases 2 and 3.

### 6.3 Sync loop

- **Schedule.** The `*/5` cron (and `server/runtime/scheduler.ts` on Node) runs `planExternalSync(env)`: up to 200 accounts with `sync_enabled`, status `active` or `error`, and `next_sync_at <= now`, oldest first, are claimed (`next_sync_at` pushed forward in the same `UPDATE … RETURNING`) and sent as `{ kind: "accounts.sync", accountId }` on `AGENT_QUEUE`, next to `import.imap` (no new queue binding). Interval per account: 5 (default and shortest), 15 or 60 minutes; forwarding (§6.1) is the answer for real-time. **Check now** enqueues one at once, at most once a minute per account.
- **Run** (`syncExternalAccount`, one account, lease `LEASE_MS` like imports, one connection):
  1. Connect, authenticate, `EXAMINE INBOX`; read `UIDVALIDITY` and `UIDNEXT` from the response.
  2. Same `UIDVALIDITY` and `UIDNEXT` as stored → nothing new: `LOGOUT`, record `last_success_at`, done. This is the common case and costs one short connection.
  3. Otherwise `UID FETCH <last_uid + 1>:* (UID FLAGS INTERNALDATE RFC822.SIZE)` (and drop the UID ≤ `last_uid` that `n:*` returns when nothing is new), then fetch bodies in chunks of 25 with `BODY.PEEK[]`, at most 200 messages or 4 minutes per run (the rest continues on a re-enqueued run).
  4. Each message is written to the Mail store at a deterministic key, `external/<accountId>/<uidvalidity>/<uid>.eml`, and enqueued on `INBOUND_QUEUE` as an `InboundQueueMessage` with a new `source: { kind: "external", accountId, read, starred }`. `last_uid` advances after every chunk. A message above the inbound size limits is skipped, counted and named in the account's recent errors; the cursor moves on.
  5. A changed `UIDVALIDITY` (the provider rebuilt the folder) resets the cursor: `UID SEARCH SINCE <last_success_at − 2 days>` is fetched again and Message-ID dedupe drops what Kite has. The account's activity shows "The provider reset the Inbox; Kite checked the last two days again."
- **Baseline.** Connecting an account stores the current `UIDVALIDITY` and `UIDNEXT − 1` as `last_uid`, so sync starts with mail that arrives after connecting. Older mail is the import's job; the connect dialog offers **Import existing mail**, which opens the import page with the account preselected (§9.2). Import and sync overlap safely through dedupe.
- **CONDSTORE and QRESYNC are not used.** QRESYNC reports expunges and flag changes, and CONDSTORE flag changes; Kite ignores both by design (D5). `UIDVALIDITY` + `UIDNEXT` already answers "anything new?" in one round trip. Flags are taken once, when the message is fetched: mail already read on the phone arrives read.
- **Spam folder (optional).** A per-account switch, off by default, also syncs `\Junk` the same way into `spam`, for users who want to see the provider's false positives in Kite.
- **Limits.** One run holds one socket (Workers allows six open connections per invocation) and makes about two subrequests per message (one object write, one queue send), so a 200-message run stays inside the Workers subrequest limit, as the import's does. Gmail's IMAP download cap (about 2.5 GB a day) only matters to imports, which back off on `[THROTTLED]`/`[LIMIT]` responses.

### 6.4 Delivery of synced mail

`processInboundMessage` gets a branch for `source.kind === "external"`, implemented as a split of the function into *resolve* and *deliver* halves rather than a second pipeline:

- The destination is the account's `mailbox_id`, after checking that the account still exists, is not removed and its owner still has full access to that mailbox. Domain routing (`resolveInboundAddress`), domain reject rules and account-level forwarding do not apply: they belong to Kite's own domains.
- **Dedupe by Message-ID** (normalized, per mailbox) before the insert, in addition to today's `raw_r2_key` idempotency. A duplicate deletes its `external/…` object and stops.
- Then everything as received mail: attachment limits, mailbox rules, `analyzeSpam` (with `authenticationResults` per §6.6), `applyScreener`, contact, thread (with the references-root fallback), insert with `external_account_id`, `read` and `starred` from the source flags, attachments, reputation, notification, `dispatchWebhooks("message.inbound")` with an added `source: "external"` and `accountId`, and `scheduleAgentWork`.
- **No auto-reply**: the provider has its own, and replying from Kite would come from a Kite address.
- A synced message that was `\Seen` at the source still triggers webhooks and automatic reading, but no notification.

### 6.5 Errors, backoff and what the user sees

`classifySyncError` (`src/lib/external-accounts/sync-utils.ts`, pure) sorts each failure:

| Class | Examples | Effect | Shown as |
| --- | --- | --- | --- |
| `auth` | `NO [AUTHENTICATIONFAILED]`, `[ALERT] … web login required`, OAuth `invalid_grant`, a sealed secret that no longer opens (`SecretBoxError`) | `status = 'auth_failed'`, sync stops, no retries | "Sign-in failed. Reconnect." with a **Reconnect** button; a sidebar notice (like `DnsSkippedBanner`); a realtime notice to the owner once |
| `tls` | certificate invalid, expired or for another host | `status = 'tls_failed'`, sync stops | "The server's certificate is not valid for imap.example.com." Editing the account retries. |
| `throttled` | `[THROTTLED]`, `[LIMIT]`, "Too many simultaneous connections" | retry, backoff starting at 15 minutes | "The provider is limiting connections; Kite will try again at 14:35." |
| `transient` | DNS failure, timeout, connection reset, `[UNAVAILABLE]`, `BYE` | retry with backoff | "Could not reach imap.example.com since 09:10; retrying." after 3 failures |
| `config` | INBOX missing, `LOGINDISABLED` with no `STARTTLS` offered, no supported authentication mechanism | `status = 'error'`, sync stops | the server's short message |

Backoff: `next_sync_at = now + min(interval × 2^failures, 6 hours)` with ±20% jitter; `consecutive_failures` resets on success. After 24 hours of transient failures the status becomes `error` (amber in the list) and Kite keeps trying every 6 hours. Server text is cut to 300 characters and never contains the credentials (they are never echoed into errors). Each state change writes an audit row (`external_account.sync_failed`, `…sync_recovered`) and a structured log (`external.sync.*`) without addresses or server text.

The **Connected accounts** list shows per account: the address, the target mailbox, "Checked 2 minutes ago, 3 new" or the state above, the next check, and **Check now**, **Pause**, **Edit**, **Remove**.

### 6.6 Authentication results of synced mail

Kite's spam engine never trusts headers inside a message; only the intake hop's verdict counts. For synced mail the provider is that hop. `externalAuthenticationResults(raw, preset)` (`src/lib/spam/authentication-results-utils.ts`) passes the **topmost** `Authentication-Results` header only when its authserv-id matches the preset (Gmail `mx.google.com`, iCloud, Yahoo/AOL and Fastmail values confirmed against real headers when the presets are built), because those providers strip incoming headers carrying their own authserv-id (RFC 8601 §5). A preset whose header cannot be tied to its own hop is not trusted: Microsoft omits the authserv-id, so Microsoft accounts (phase 4) get none until a reliable rule is proven. Custom hosts get none. Without results, mail is treated like mail from the SMTP listener today: `authPassed` is false and invites show the unverified-sender note.

### 6.7 Deletes, moves and removal

- A message deleted or moved at the source after Kite fetched it stays in Kite unchanged. Before Kite fetched it (inside the poll window), it never arrives.
- A message moved *into* INBOX at the source gets a new UID and is fetched, then dropped by dedupe if Kite has it.
- Nothing in Kite (read, move, delete, spam) is written back.
- **Removing an account** deletes its credentials, cursors and identities and stops sync and send-as. It never deletes mail: messages keep their content, `external_account_id` is set to null (FK `ON DELETE SET NULL`). Pending `external/…` objects are delivered or cleaned by the normal inbound path.

## 7. Phase 3: send as the external address

### 7.1 Why the provider's SMTP and not Kite's own sending

Sending `From: someone@gmail.com` through Cloudflare Email Sending, Resend or SES fails twice:

- **The providers refuse it.** All three send only from domains (or, on SES, addresses) verified with them; Kite cannot verify `gmail.com`.
- **DMARC fails even where it is accepted.** SPF would authenticate the provider's bounce domain and DKIM Kite's own domain, neither aligned with `gmail.com`, so the message fails DMARC. Domains such as `yahoo.com` and `aol.com` publish `p=reject`, others `p=quarantine`, and any of them can tighten tomorrow; Gmail and Yahoo require DMARC alignment from bulk senders and use it heavily for everyone else. The result is rejection or the spam folder, it looks like spoofing to the recipient's mail system, and it puts the reputation of the operator's sending domain at risk.

Submitting through the provider's own server (`smtp.gmail.com`, `smtp.mail.me.com`, `smtp.fastmail.com`, …) on port 465 (implicit TLS) or 587 (`STARTTLS`) means the provider signs with its DKIM key and sends from its own IPs, so SPF, DKIM and DMARC all align. Workers can open both ports (only port 25 is blocked), and Node can too.

### 7.2 Identities and ownership

- An account's login address is a send-as identity once the SMTP test on connect succeeds with the account's credentials **and** the address equals the login user name (case-insensitively). Proving the credentials proves the address; the big providers additionally refuse or rewrite a From they do not own.
- Any other address (a provider alias, or a login user name that is not an address) needs a **verification code** first: Kite sends a 6-digit code with `sendSystemEmail` to that address, valid 30 minutes, 5 attempts, stored hashed. This is the roadmap's "a code sent to it" and stops anyone sending as an address they do not receive (phase 3b, `external_identities`).
- Only the account's owner can send as its identities. Sharing a mailbox never shares someone's Gmail credentials; send-as for shared mailboxes stays with Kite domains.

### 7.3 Sending path

- **Composer.** The From menu (`/api/mailboxes` identities, read by `use-compose-mailbox.ts`) lists, after the mailbox's own addresses, the verified identities of the current user's accounts that deliver into that mailbox. Replying to or forwarding a message with `external_account_id` preselects that account's address. An identity of an account in `auth_failed` is shown disabled with "Reconnect".
- **Authorization.** `getAuthorizedSenderAddress` accepts a From that is a verified identity of an active account owned by the acting user and delivering into the selected mailbox; it returns `{ fromAddr, mailboxId, externalAccountId }`. Connecting an account whose address is on a Kite domain of this install is refused, so the two never compete.
- **Transport.** `getOutboundProviderConfig` gains `{ provider: "smtp", accountId }`, chosen when the send carries `externalAccountId`; `sendThroughProvider` hands it to `sendViaSubmission` (`src/lib/external-accounts/submit.ts`): build the MIME (§7.5), open the SMTP session, `MAIL FROM:<address>`, one `RCPT TO` per To, Cc and Bcc address, `DATA`, close. Bcc is in the envelope only.
- **Everything around it is unchanged:** send limits (`send-limits.ts`), undo and scheduled send through `outbound_jobs` (the transport is resolved when the job runs, so an account removed in the meantime fails the job with "The account was removed"), the Sent row (outbound, `sent`, with `external_account_id`), webhooks and the writing style hooks.
- **Message-ID.** Kite mints `<kite.<id>@<external domain>>` and stores it as `provider_message_id`; Gmail, iCloud and Fastmail keep a supplied Message-ID, so replies thread. The sent MIME is stored at `sent/<messageId>.eml` (`raw_r2_key`), which also gives export the exact bytes.
- **Errors.** SMTP `4xx` → the outbound job retries with its existing backoff; `5xx` → the send fails and shows in Sent as failed with the server's reply (cut to 300 characters); `535` (authentication) also sets the account to `auth_failed` (§6.5). Size: each preset carries the provider's message limit (Gmail 25 MB including encoding); larger mail is refused before queueing with the limit named. Cloudflare's 5 MiB link fallback does not apply.

### 7.4 Sent copy at the source

Gmail saves every SMTP submission in Sent itself, so its preset has `appendSent: false` (an `APPEND` would duplicate it); the other presets are confirmed against the real service when built (Microsoft 365 is expected to save submissions too). For the rest, after a successful send, `{ kind: "accounts.append_sent", accountId, messageId }` on `OUTBOUND_QUEUE` appends the stored MIME to the account's `\Sent` folder with `(\Seen)`, three attempts, and failure never fails the send (it is logged and shown in the account's recent errors). Per-account switch "Save a copy in the provider's Sent folder", defaulting from the preset. Sync never reads `\Sent`, and dedupe would drop it anyway.

### 7.5 MIME builder

There is no MIME library in the codebase; outbound mail is structured. `src/lib/email/mime-build-utils.ts` (pure, no dependency) builds RFC 5322 bytes from the same `OutboundProviderMessage` the other providers take: `multipart/mixed` › `multipart/alternative` (text, HTML) and `multipart/related` for inline images; RFC 2047 encoded words for non-ASCII headers; folded header lines; base64 bodies wrapped at 76 characters; CRLF line endings; generated boundaries. Dot-stuffing belongs to the SMTP client. The same bytes are used for `APPEND` and stored as the Sent raw. nodemailer's composer is not used: it is Node-only in practice and would give the two runtimes different output.

## 8. Both runtimes: the socket adapter

```ts
// env.d.ts
TCP_CONNECT?: (
	address: { hostname: string; port: number },
	options: { secureTransport: "on" | "starttls" | "off"; allowHalfOpen: false },
) => MailSocket; // readable, writable, opened, closed, close(), startTls(): MailSocket
```

- **Workers.** `TCP_CONNECT` is unset; `src/lib/net/connect.ts` falls back to `connect` from `cloudflare:sockets`, which has exactly this shape (including `secureTransport: "starttls"` and `startTls()`).
- **Node.** `server/runtime/tcp-connect.ts` implements it with `node:net` and `node:tls`, wrapping the duplex in web streams (`Duplex.toWeb`). It resolves the host itself (`dns.lookup`, all addresses), refuses the connection if **any** address is private (`isPrivateIpAddress`), and connects to the first vetted address with `servername` set to the host name, so SNI and certificate verification use the name while a DNS answer cannot change between the check and the connection. `rejectUnauthorized` is always true. `startTls()` upgrades the same socket with `tls.connect({ socket, servername })`.
- `src/lib/imap/` (client, moved out of `src/lib/import/imap.ts`) and `src/lib/smtp/` take a `MailSocket` from `openMailSocket(env, { host, port, security })`, so neither knows the runtime. `security` is `tls` or `starttls`; `none` exists only behind the dev flag (§11.3).
- New IMAP commands: `CAPABILITY`, `STARTTLS` (refusing to authenticate if the server advertises `LOGINDISABLED` and the upgrade did not happen), `AUTHENTICATE PLAIN` (preferred over `LOGIN`, with `SASL-IR`), `AUTHENTICATE XOAUTH2` (phase 4), `LIST … RETURN (SPECIAL-USE)`, `STATUS`, `UID FETCH` with `FLAGS INTERNALDATE RFC822.SIZE X-GM-LABELS`, `APPEND`, `ID` (some providers, such as NetEase, refuse clients that do not send it). The SMTP client: `EHLO`, `STARTTLS`, `AUTH PLAIN`/`LOGIN`/`XOAUTH2`, `MAIL FROM` with `SIZE`, `RCPT TO`, `DATA` with dot-stuffing, `QUIT`; no pipelining.

## 9. Module boundaries

### 9.1 What lives where

| Code | Location | Kind |
| --- | --- | --- |
| Socket adapter, IMAP and SMTP clients, MIME builder | `src/lib/net/`, `src/lib/imap/`, `src/lib/smtp/`, `src/lib/email/mime-build-utils.ts`, `server/runtime/tcp-connect.ts` | core |
| Connected accounts: connect, test, edit, remove, presets, credentials, sync, send-as, Sent copy, OAuth | `src/lib/external-accounts/`, `src/app/api/external-accounts/*`, `src/app/(settings)/settings/connected-accounts/` | core |
| Inbound delivery of synced mail | `src/lib/email/inbound.ts` (the external branch) | core |
| One-time import: folder and whole-account jobs, estimate, mapping, file uploads | `src/lib/import/`, `src/lib/modules/import/`, `/settings/import`, `/api/import` | Mail import module |

Sync is not part of the import module because its consumers are all core surfaces listed in `tests/module-imports.test.mjs` (`worker.ts`, `server/runtime/scheduler.ts`, `src/components/compose/`), and because a module's off switch means "paused, resumes later" (imports) while a receiving or sending provider must not silently stop when an unrelated module is turned off. Connected accounts get their own controls instead (§9.3).

### 9.2 How the import module uses an account

- The import module keeps importing `@/lib/imap` (core), as it imports `@/lib/email/parse` today.
- Importing **from a connected account** adds `import_jobs.external_account_id`. The job then holds no password of its own: each run asks core through a new host service, `moduleHost.accounts.sourceLogin(ctx, accountId)`, which checks that the account belongs to the job's user and returns the login as JSON (`{ host, port, security, username, auth: { kind: "password", password } | { kind: "xoauth2", user, accessToken } }`), refreshing an OAuth token when needed. Nothing is copied into the job, so removing the account stops its imports at the next run ("The account was removed").
- `moduleHost.mail.importMessages` gains the per-message `read`, `starred` and `receivedAt` (§4.2) and an `approveSentRecipients` flag: when the import includes the Sent folder and the user ticks "Treat people I have written to as approved", the recipients of imported Sent mail are approved in the Screener (`approveSentRecipients`, `src/lib/screener/release.ts`).
- Core never imports the module. The Connected accounts page links to `/settings/import?account=<id>` only when the module is on for the viewer (`useModules()`).

### 9.3 Controls

- Install switch **Allow connected accounts** under Admin → General (`app_settings.external_accounts_enabled`). It is on by default only when `APP_ENCRYPTION_KEY` is set; without the key it is off and cannot be turned on (the page explains why). Turning it off pauses every account's sync and hides send-as; credentials stay until removed or the switch has been off for 30 days, after which the daily cron erases them and marks the accounts `disabled`.
- Per user: a core permission `users.can_connect_accounts` (default true) under Accounts → Permissions, next to the other `canManage*` flags. Revoking it pauses that user's accounts the same way.
- Routes `/api/external-accounts/*` use `requireSessionUser`; nothing is reachable with an API key or MCP in these phases.

## 10. Data model and migrations

Numbers are taken at build time; each PR adds its own migration, with backup lists updated in the same PR (`AGENTS.md`).

### 10.1 Phase 1

- `import_jobs`: `scope text NOT NULL DEFAULT 'folder'` (`folder | account`), `options text NOT NULL DEFAULT '{}'` (JSON: included roles, `approveSentRecipients`, Gmail strategy), `estimate_bytes integer`, `pause_reason text`, `paused_at integer`; `status` gains `paused` (the column is free text in SQLite; the Drizzle enum is widened). `folder` stays for `scope = 'folder'`.
- `import_job_folders` (new): `id`, `job_id` → `import_jobs` cascade, `position`, `source_name`, `role` (`inbox | sent | archive | junk | trash | all | user`), `destination`, `uidvalidity`, `total`, `total_bytes`, `cursor_uid`, `processed`, `imported`, `skipped`, `status` (`pending | running | completed | skipped | failed`), `last_error`, `updated_at`. Index `(job_id, position)`.
- `messages`: `html_body_key text` (§5.3).
- Backups: `import_job_folders` joins `import_jobs` in `INTERNAL_TABLES` (transient work that points at queue messages).

### 10.2 Phase 2

- `external_accounts` (new): `id`, `user_id` → `users` cascade, `mailbox_id` → `mailboxes` cascade, `label`, `address` (lowercase, **unique per install**), `display_name`, `preset` (`gmail | google_workspace | microsoft | icloud | yahoo | aol | fastmail | other`), `auth_kind` (`password | oauth_google | oauth_microsoft`), `imap_host`, `imap_port`, `imap_security` (`tls | starttls`), `smtp_host`, `smtp_port`, `smtp_security`, `username`, `secret` (sealed password; empty for OAuth), `sync_enabled`, `sync_interval_minutes`, `sync_junk`, `send_enabled`, `append_sent`, `trust_auth_results`, `status` (`active | paused | auth_failed | tls_failed | error | disabled`), `status_reason`, `last_error`, `recent_errors` (JSON, last 20), `consecutive_failures`, `next_sync_at`, `last_sync_at`, `last_success_at`, `lease_until`, `created_at`, `updated_at`. Indexes `(user_id)`, `(status, next_sync_at)`.
- `external_account_folders` (new): `account_id` → cascade, `name`, `role` (`inbox | junk`), `uidvalidity`, `last_uid`, `uidnext`, `last_checked_at`; primary key `(account_id, name)`.
- `messages`: `external_account_id text REFERENCES external_accounts(id) ON DELETE SET NULL`. No new index at first; the "via account" filter rides `messages_counts_idx` plus a column filter, measured before adding one.
- `users`: `can_connect_accounts integer NOT NULL DEFAULT 1`. `app_settings` keys need no migration.
- `import_jobs`: `external_account_id text` (FK `SET NULL`).
- Backups: `external_accounts` and `external_account_folders` in the `accounts` group after `mailboxes` (FK order), so a restore resumes sync from the backup's cursors and dedupe drops what was already there. **The export strips `secret` and the token columns** and a restore sets those accounts to `auth_failed` with "Reconnect after restore": a backup document travels (downloads, the Backups store), and reconnecting takes a minute (decision 6).
- Before the migration is applied: reads answer `{ accounts: [], migrationPending: true }` and writes 409 `MIGRATION_PENDING`, like Drive (`answerDrive`); the cron skips sync while the table is missing (`sqlite_master` check, cached per isolate).

### 10.3 Phase 3

- `external_identities` (new, phase 3b): `id`, `account_id` → cascade, `address` (unique per account), `display_name`, `verified_at`, `code_hash`, `code_expires_at`, `attempts`, `created_at`. The login address needs no row (§7.2). Backed up in `accounts` without the code columns.
- `outbound_jobs` payloads gain `externalAccountId` (JSON, no migration).

### 10.4 Phase 4

- `external_accounts`: `oauth_refresh_token` (sealed), `oauth_access_token` (sealed), `oauth_expires_at`, `oauth_scopes`, `oauth_token_version integer NOT NULL DEFAULT 0`, `oauth_subject` (the provider's stable user id).
- `app_settings`: `oauth_google_client` and `oauth_microsoft_client` (sealed JSON `{ clientId, clientSecret, tenant? }`); env vars `GOOGLE_OAUTH_CLIENT_ID`/`_SECRET` and `MICROSOFT_OAUTH_CLIENT_ID`/`_SECRET` win when set, as `RESEND_API_KEY` does.
- `oauth_states` (new, internal): `state` hash, `user_id`, `provider`, `code_verifier` (sealed), `account_id` (reconnect), `expires_at` (10 minutes). In `INTERNAL_TABLES`.

## 11. Security

### 11.1 Credentials

- Sealed with `APP_ENCRYPTION_KEY` (`sealSetting`); connecting is refused without a key (D9). Never returned by any API (the serializer lists fields explicitly, as `serializeImportJob` does), never logged, never in error text, never in webhooks or audit metadata.
- Opened only in the run that uses them. `SecretBoxError` (key changed) sets `auth_failed` with "Reconnect".
- Removing an account, revoking the permission, deleting the user or 30 days with the install switch off erases them.
- Admins never see another user's credentials or synced mail through this feature; they see that a user has N connected accounts and their states (Admin → Accounts → user).

### 11.2 SSRF to arbitrary IMAP and SMTP hosts

`assertMailServerHost(env, host, port)` (`src/lib/external-accounts/host-guard.ts`), modelled on `assertStoreEndpoint`, runs when an account is saved, before every connection, and for import jobs:

- `isBlockedHost` (names such as `localhost`, `.internal`, `.local`, private and reserved IP literals, bare names).
- Ports limited to 143, 993, 465 and 587 (and any port only under the dev flag), so the feature cannot be used to probe other services.
- On Node, every resolved address checked, and the connection pinned to a checked address (§8). On Workers, `connect()` egresses from Cloudflare's network and cannot reach the operator's private network, so the literal check is the guard there.
- `EXTERNAL_ACCOUNTS_ALLOW_PRIVATE_HOSTS=1` (Node only, like `STORAGE_ALLOW_PRIVATE_ENDPOINTS`) allows LAN mail servers for self-hosters; never on Workers.
- Connection tests are rate-limited per user (`LOGIN_RATE_LIMIT`-style binding, 10 per 10 minutes), so the connect form cannot be used to guess passwords at a provider or to scan hosts.

### 11.3 TLS

Implicit TLS or `STARTTLS` only, certificates always verified (Workers verifies by default and offers no opt-out; Node keeps `rejectUnauthorized`). `STARTTLS` failure aborts before any credential is sent, so a downgrade cannot leak the password. `EXTERNAL_ACCOUNTS_ALLOW_INSECURE_LOOPBACK=1` allows plain TCP to `127.0.0.1` outside production only, for the e2e fakes, mirroring `AI_ALLOW_INSECURE_LOOPBACK`.

### 11.4 Mail content

Synced mail is untrusted exactly like received mail: the same sanitizing (`sanitizeStoredEmailHtml`), attachment limits, spam and phishing analysis, and the automatic-reading injection defences. Provider headers are never trusted except the one `Authentication-Results` rule of §6.6.

### 11.5 Sending

Send-as is limited to the owner and to verified addresses (§7.2), counts against the user's send limits, and refuses addresses on Kite domains. A compromised Kite session can send as the user's Gmail; that is inherent to the feature and is why the connect dialog asks for the Kite password again (the same re-authentication as security settings) and why removing the account is one click.

## 12. Privacy

- `docs/privacy.md`: connected accounts store sealed credentials and sync state; Kite connects to the IMAP and SMTP servers the user names (and, in phase 4, Google's or Microsoft's OAuth endpoints); nothing else leaves. Synced mail is stored like received mail; removing an account keeps the mail and deletes the credentials.
- Shared target mailboxes: connecting an account into a mailbox others can read shows "Everyone with access to Support will see mail from this account." Choosing a mailbox requires full access to it.
- Export (`/settings/export`) covers synced and imported mail like all mail. Account deletion and user deletion cascade.
- The automatic-reading opt-in for external AI providers applies to synced mail exactly as to received mail.

## 13. Cost

- **Sync on Workers**: per account and 5-minute interval, about 8,640 queue messages and invocations a month (Queues bill roughly three operations per message, so about 26,000 operations, a few cents per account at list price), plus a few milliseconds of CPU for an unchanged INBOX. The connection itself is egress, which Workers does not bill. A 15- or 60-minute interval cuts this proportionally.
- **New mail** costs what received mail costs: one Mail store write for the raw MIME and attachments, D1 rows (the message, FTS, contact), plus automatic reading if on.
- **Imports**: storage dominates. 6 GB of source mail is about 10 GB of Mail store (until attachments are stored once) at R2's list price of $0.015 per GB-month (about $0.15 a month), and the D1 share of §5.2 (D1 bills storage above 5 GB at about $0.75 per GB-month, and rows written above 50 million a month; a 100,000-message import writes a few million rows). Check current Cloudflare pricing; the estimate screen shows sizes, not prices.
- **Node**: no platform cost; disk only.

## 14. Test plan

### 14.1 Unit (`tests/*.test.mjs`, no bindings)

- IMAP parsing (`src/lib/imap/*-utils.ts`): `LIST` with special-use and delimiters, `STATUS`, `FETCH` with `FLAGS`/`INTERNALDATE`/`RFC822.SIZE`/`X-GM-LABELS` before or after the literal, capability lists, `[ALERT]`/`[THROTTLED]` response codes.
- Folder mapping and the Gmail label rule (`folder-mapping-utils.ts`), flag mapping, Message-ID normalization and the SHA-256 fallback key, references-root threading.
- Estimate maths and thresholds (`estimate-utils.ts`).
- Sync bookkeeping (`sync-utils.ts`): baseline, the `n:*` quirk, run caps, `UIDVALIDITY` reset, backoff with jitter bounds, `classifySyncError`.
- SMTP replies (multi-line, enhanced codes), dot-stuffing; the MIME builder (structure, encoded words, folding, 76-column base64, CRLF) checked by re-parsing with `parseRawMime`.
- `assertMailServerHost` (ports, names, literals) and the Node connector's pinning with a stubbed resolver (a name resolving to one public and one private address is refused).
- Preset detection by address domain and by MX (Google Workspace, Microsoft 365) with stubbed DNS; the `Authentication-Results` trust rule per preset.
- Phase 4: the XOAUTH2 string, the refresh decision (expiry margin, token version compare-and-swap), state and PKCE handling.

### 14.2 Fake servers

There are none today, so two are added and shared by unit-level integration tests and e2e:

- `e2e/support/fake-imap.ts`: a small IMAP4rev1 server over `node:net` with in-memory folders, UIDs, flags and `UIDVALIDITY`; `CAPABILITY`, `LOGIN`, `AUTHENTICATE PLAIN`/`XOAUTH2`, `LIST` with special-use, `STATUS`, `SELECT`/`EXAMINE`, `UID SEARCH`, `UID FETCH`, `APPEND`, `NOOP`, `LOGOUT`, optional `X-GM-EXT-1` mode, optional `STARTTLS` with a generated self-signed certificate. A control API (in-process for tests, an HTTP port for e2e) adds messages, sets flags, bumps `UIDVALIDITY`, fails the next login, throttles and records commands. Hand-written rather than GreenMail (Java, needs Docker in the E2E shards) or `hoodiecrow-imap` (unmaintained), because failure injection is the point.
- `e2e/support/fake-smtp.ts` on the existing `smtp-server` dependency: `AUTH PLAIN`/`LOGIN`/`XOAUTH2`, implicit TLS or `STARTTLS`, records envelopes and data, can answer `4xx`/`5xx`/`535` on demand.
- `tests/external-accounts-node.test.mjs` runs the IMAP and SMTP clients through the **Node** connector against both fakes, including `STARTTLS` with the test certificate passed through a test-only `ca` option of the connector factory (never reachable from env). This is the Node runtime's coverage; e2e runs the workerd dev server.

### 14.3 e2e (`npx playwright test`, workerd dev server)

`playwright.config.ts` sets `EXTERNAL_ACCOUNTS_ALLOW_INSECURE_LOOPBACK=1` and starts the fakes in `global-setup.ts`. The first PR confirms that local workerd's `connect()` reaches `127.0.0.1`; if not, the fakes listen on a non-loopback local address allowed by the same flag.

- `e2e/59-import-account.spec.ts`: whole-account job with INBOX, Sent, a user folder and Gmail mode; read and starred state; folder mapping; dedupe on a second run; pause and resume; the estimate warning with a tiny `D1_MAX_BYTES`; threading of a reply imported before its parent.
- `e2e/60-connected-accounts.spec.ts`: connect (test, preset, mailbox), a message added at the fake appears after **Check now** and is not duplicated; `UIDVALIDITY` reset; sign-in failure state, sidebar notice and Reconnect; the Screener holds an unknown sender; a spam message goes to Spam; with the fake model, automatic reading runs on synced mail and not on imported mail; removing keeps the mail.
- `e2e/61-send-as.spec.ts`: From menu, envelope and headers at the fake SMTP, the Sent copy in Kite, `APPEND` at the fake IMAP for a non-Gmail preset and none for Gmail, a reply defaults to the account's address, an unverified alias cannot be chosen, `535` marks the account.
- Module off: an import from an account pauses, sync keeps running.
- Each UI spec checks Kite, Kite classic, Classic and dark mode for the new screens, as `AGENTS.md` asks.
- Phase 4: `EXTERNAL_OAUTH_TEST_ORIGIN` (dev only, like `ABUSE_CH_TEST_ORIGIN`) points the authorize and token endpoints at a fake, covering consent, callback, refresh and `invalid_grant`. Real Google and Microsoft accounts are a manual check; CI has no provider credentials.

## 15. Phase 4: OAuth for Microsoft and Google (designed, sized separately)

### 15.1 App registration per install

Kite ships no shared OAuth app (roadmap). The owner registers one in Google Cloud and/or Microsoft Entra and enters the client id and secret under Admin → General → Connected accounts (or the env vars of §10.4). `docs/providers.md` gets the steps, with the redirect URI `${APP_URL}/api/external-accounts/oauth/callback` (needs a public HTTPS `APP_URL`; `http://localhost` works for development).

- **Google.** The `https://mail.google.com/` scope (the only one that grants IMAP and SMTP) is restricted: a public app needs verification and a yearly security assessment. An **Internal** app (Workspace) needs neither and is the target. A personal Gmail user can use an External app in *Testing* with themselves as test user, but Google expires refresh tokens of Testing apps after 7 days, so personal Gmail keeps the app password route (it works today) and the UI says so.
- **Microsoft.** A multitenant registration with personal accounts (`common` endpoint), or single-tenant for one organisation. Business tenants may require admin consent for the IMAP and SMTP scopes, and SMTP AUTH must be enabled for the mailbox in Exchange Online; the error screens say both.

### 15.2 Flow and scopes

Authorization code with PKCE. `state` and the verifier live in `oauth_states` for 10 minutes and are single-use; the callback checks the session user against the state, exchanges the code, reads the address from the ID token (`email` claim, or `preferred_username` for Microsoft) and refuses when it differs from the account being reconnected.

| Provider | Scopes |
| --- | --- |
| Google | `https://mail.google.com/`, `openid`, `email`; `access_type=offline`, `prompt=consent` (to get a refresh token) |
| Microsoft | `https://outlook.office.com/IMAP.AccessAsUser.All`, `https://outlook.office.com/SMTP.Send`, `offline_access`, `openid`, `email` |

### 15.3 Tokens

- Refresh and access tokens sealed in `external_accounts`; access tokens are cached until 5 minutes before `oauth_expires_at`.
- Refresh is single-flight per account: the refresher bumps `oauth_token_version` with a compare-and-swap `UPDATE … WHERE oauth_token_version = ?`, and a loser re-reads instead of refreshing again. Microsoft rotates refresh tokens on every refresh, so the new one is always stored; Google's stays.
- `invalid_grant` (revoked, password changed, Testing-app expiry, 90 days unused at Microsoft) → `auth_failed` and Reconnect (§6.5).
- The token endpoint is reached with `fetch` through `assertPublicHttpUrl` against fixed provider origins.

### 15.4 XOAUTH2

`base64("user=" + address + "\x01auth=Bearer " + accessToken + "\x01\x01")`, sent as IMAP `AUTHENTICATE XOAUTH2 <b64>` (with `SASL-IR`; otherwise after the `+` continuation) and SMTP `AUTH XOAUTH2 <b64>`. On failure the server sends a base64 JSON error as a continuation; the client answers with an empty line to receive the final `NO`/`535` and maps a `401` status to a token refresh and one retry before `auth_failed`.

### 15.5 Microsoft's basic auth retirement

Outlook.com ended password sign-in for IMAP, POP and SMTP in September 2024, and Exchange Online has been retiring basic authentication for SMTP AUTH client submission (announced for 2026) after IMAP and POP. Microsoft accounts are therefore **OAuth-only**: the Microsoft presets offer no password field, and their sync and send-as arrive only with phase 4. Google Workspace ended password sign-in for third-party apps in 2025 except where the admin allows app passwords, so Workspace works with app passwords where allowed and with OAuth otherwise.

### 15.6 Sizing

About 6 to 9 days: the OAuth framework with the fake token server (3 to 4), Microsoft (2 to 3) and Google (1 to 2). Microsoft is the first OAuth provider, because app passwords already cover personal Gmail, iCloud, Yahoo and Fastmail and nothing else reaches Outlook.com or Microsoft 365.

## 16. Rollout

1. Phase 1 ships inside the Mail import module; there is no switch beyond the module's. The old single-folder form remains as **One folder**.
2. Phase 2 ships with the install switch on by default only when `APP_ENCRYPTION_KEY` is set, and off otherwise. The forwarding guide ships first, in the same release as phase 2's first PR.
3. Phase 3 ships with send-as on for every connected account; an account can turn it off.
4. Every migration is applied from the admin overview as usual; the pages show "Apply the database update to use this" until then (§10.2).
5. Docs per PR: `docs/external-accounts.md` (user guide: forwarding, connecting, import, states), `docs/providers.md` (presets, app passwords, OAuth registration), `docs/privacy.md`, `docs/operations.md` (logs `external.sync.*`, `external.submit.*`, the database warning, body objects in backups), `docs/modules.md` (import now does whole accounts), `CLAUDE.md` (architecture: connected accounts, the socket adapter), each with a `changelog.d/` fragment that names its migration.
6. Observability: Analytics Engine metrics `external_sync` (accounts checked, new messages, failures by class) and `import` bytes, so drift shows on the existing dashboard queries.

## 17. Sizing into PRs

| # | PR | Phase | Size |
| --- | --- | --- | --- |
| 1 | Socket adapter (`TCP_CONNECT`, Node connector with pinning), IMAP client moved to `src/lib/imap/` with `CAPABILITY`/`STARTTLS`/`AUTHENTICATE PLAIN`, plain text removed (with a Security changelog entry), port limits; fake IMAP server; Node integration tests. The existing single-folder import now works on Node. | 1 | M (1.5–2 d) |
| 2 | Read and starred state, `INTERNALDATE`, bracket-insensitive dedupe, SHA-256 fallback key, references-root threading for imports | 1 | S (1 d) |
| 3 | Whole-account jobs: `import_job_folders`, special-use and Gmail mapping, mapping table, progress per folder, pause and resume | 1 | L (2–3 d) |
| 4 | Database size (`getDatabaseSize`, Node `size_after`), estimate, thresholds, self-pause, admin overview warning | 1 | M (1–1.5 d) |
| 5 | HTML body offload (`html_body_key`, `loadMessageBodies`, every reader switched) for imported mail | 1 | M–L (1.5–2 d) |
| 6 | Connected accounts: migration, presets and MX detection, connect and test, Connected accounts page, install switch and permission, `sourceLogin` host service, import from an account, audit | 2 | L (2–3 d) |
| 7 | Sync: cron and queue, cursors, external inbound branch, Message-ID dedupe, spam with trusted A-R presets, Screener, automatic reading, webhooks, error classes, backoff, sidebar notice, Check now | 2 | L (2–3 d) |
| 8 | Forwarding guide, "via account" chip and filter, Spam-folder sync switch | 2 | S (0.5–1 d) |
| 9 | SMTP client and MIME builder; fake SMTP server | 3 | M (1.5 d) |
| 10 | Send-as: identities in the From menu, authorization, `smtp` transport in `outbound-provider.ts`, reply default, Sent raw, Sent copy via `APPEND`, error mapping | 3 | L (2–3 d) |
| 11 | Alias verification codes (`external_identities`) | 3 | S (1 d) |
| 12–14 | OAuth framework, Microsoft first, then Google (§15.6) | 4 | 6–9 d, separate approval |

Phases 1 to 3: about 16 to 22 days of work in 11 PRs. PR 5 stays in phase 1 (decision 2), even though nothing blocks it from landing after PR 7. PRs 1 and 9 are the only ones that change shared protocol code; review them first. PRs 6, 7 and 10 touch credentials and authentication, so they get the Foreman's review before auto-merge.

## 18. Decisions (2026-10-27, Michiel)

Michiel accepted the recommended answer to each open question of the draft. The spec above is written to match.

1. **Where mail goes.** An external account delivers into an existing mailbox, with a "via <provider>" chip and a filter (D1). An account as its own sidebar mailbox needs mailboxes without a Kite domain, which touches routing, DNS and every address path; revisit if users ask.
2. **Large HTML bodies.** Offloaded to object storage in phase 1 (PR 5), only for imported and synced mail (D12, §5.3). A single whole-account import can be what fills D1, and the estimate warns but does not prevent it.
3. **Spam filter and Screener.** Both apply to synced mail (D3). The provider's `Authentication-Results` is trusted only where it is proven to come from that provider's own server (§6.6).
4. **Sent copies.** Appended at the provider unless it saves submissions itself (Gmail), on by default, with a per-account switch (D8, §7.4).
5. **Connected accounts by default.** On by default only when `APP_ENCRYPTION_KEY` is set, with an install switch and a per-user permission (§9.3).
6. **Credentials in backups.** Backups keep accounts and sync positions but strip encrypted passwords and tokens; users reconnect after a restore (§10.2). This is stricter than storage and AWS credentials, which stay sealed in backups, because these are personal mailbox passwords.
7. **Plain-text IMAP.** Dropped (no TLS or STARTTLS), imports included, with a `### Security` changelog entry when it is built (D10, PR 1).
8. **Conversation grouping.** The references-root rule applies only to imported and synced mail for now (§4.4).
9. **Shortest check interval.** 5 minutes, with 15 and 60 as options (§6.3).
10. **First OAuth provider.** Microsoft, in phase 4 (§15.6).
