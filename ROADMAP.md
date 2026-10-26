# Roadmap

Planned work, grouped into milestones. Each milestone is sized to run as one [Factory Mission](https://docs.factory.ai/cli/features/missions): it lists features with acceptance criteria, and every feature ends with the same validation. Items within a milestone are independent unless noted.

Shipped work is listed in the [changelog](CHANGELOG.md). Suggest features and vote on them in [Ideas](https://github.com/midego1/kite/discussions/categories/ideas).

Shipped specs: [automatic mail reading agent](docs/specs/auto-agent.md) ([#28](https://github.com/midego1/kite/pull/28)), [module platform](docs/specs/module-platform.md) ([#45](https://github.com/midego1/kite/pull/45)) and [Money Watch](docs/specs/money-watch.md) ([#50](https://github.com/midego1/kite/pull/50)). Next, in order: the approved [Drive and storage](docs/specs/drive-storage.md) and [storing attachments once](docs/specs/attachments-once.md). Proposed, not yet approved: [AI writing](docs/specs/ai-writing.md), [thread summaries](docs/specs/thread-summaries.md), [search by meaning](docs/specs/semantic-search.md) and [the assistant by email](docs/specs/assistant-by-email.md) (milestones 27 to 30).

## Working on this repository

Give a mission (or any contributor) this context.

**Start the app**

```bash
npm install
npm run db:migrate:local
npm run dev            # http://localhost:3000, logs in the terminal
npm run db:seed        # once: admin@example.com / demo-password-change-me, 15 messages
```

**Validate every feature**

```bash
npm run check          # type-check, lint, unit tests (node:test)
npm run build          # full Worker build
npm run test:e2e       # Playwright, own server on :3200 with an isolated database
```

A feature is done only when all three pass and it has a new or updated test: a `tests/*.test.mjs` unit test for pure logic, an `e2e/*.spec.ts` browser test for anything a user can see. Read `CLAUDE.md` and `AGENTS.md` first; `AGENTS.md` has the rules for migrations and backups.

**Rules that apply to every milestone**

- Tabs, `@/*` imports, types in `*-types.d.ts` and pure helpers in `*-utils.ts` next to the component.
- New tables: update the backup lists in the same change (see `AGENTS.md`). Migrations are hand-written in `drizzle/migrations/` with a journal entry.
- No new runtime dependency without a reason in the commit message; the app must keep working on both Workers and the Node/Docker runtime.
- Never commit secrets, real mail or customer data.

## Milestone 1: Right-to-left and international text

Make the app usable for Arabic, Hebrew, Persian and Urdu mail and users.

1. **RTL message content**
   - Message bodies, subjects, previews and sender names render with `dir="auto"`, so an Arabic email reads right to left inside an English UI.
   - The sandboxed email frame sets `dir="auto"` on its body and keeps the sender's own `dir` attributes.
   - Plain-text messages with RTL text align right.
   - Test: an e2e spec delivers an Arabic and a Hebrew message (inbound helper in `e2e/support/helpers.ts`) and asserts the computed `direction` in the list, the reader and the frame.
2. **RTL composer**
   - The rich-text editor and subject field use `dir="auto"` per paragraph; a toolbar button switches the current paragraph's direction.
   - Sent HTML keeps the `dir` attributes; `htmlToPlainText` output is unchanged for LTR text.
   - Test: unit tests for the HTML helpers in `rich-text-utils.ts`, and an e2e spec that types Arabic, sends it and checks the sent HTML.
3. **Logical CSS throughout**
   - Replace physical Tailwind utilities (`ml-`, `mr-`, `pl-`, `pr-`, `left-`, `right-`, `text-left`, `rounded-l-` and similar, in about 37 files) with logical ones (`ms-`, `me-`, `ps-`, `pe-`, `start-`, `end-`, `text-start`).
   - Directional icons (chevrons, arrows, the reply icon) flip with `rtl:` variants.
   - Test: a lint rule or unit test that fails on new physical utilities in `src/`.
4. **RTL interface setting**
   - A setting in the account menu (next to Reading layout) for interface direction: Automatic (from the browser language), Left to right, Right to left. Stored like the reading layout.
   - The root `<html>` gets `dir` before first paint, with no layout flash.
   - The reading pane divider, sidebar, dropdowns, toasts and dialogs mirror correctly.
   - Test: e2e spec switches to RTL and checks the sidebar sits on the right, the divider still resizes, and the account menu opens in place.
5. **Interface translations (foundation)**
   - Introduce a small message catalog (no heavy dependency) with English as the source and one RTL language as the first translation.
   - Start with the shell: sidebar, account menu, message list, reader toolbar, composer.
   - Dates and times use `Intl` with the user's locale.

## Milestone 2: Backups and restore at scale

1. **Streaming restore**: restore reads the backup from R2 in pages and inserts in batches, so a backup larger than Worker memory restores. The safety backup and rollback keep working. Test: unit tests for the page reader; e2e restore of a backup with several thousand messages.
2. **Attachments and raw mail in backups**: optional full backup that also copies R2 objects (raw MIME and attachments) to a dated prefix, with a manifest. Restore can bring them back. Off by default, with the size shown before running.
3. **Retention on by default**: new installs keep the last 14 daily backups; the setting is visible on the Backups page. Existing installs are not changed.
4. **Backup health**: the admin overview shows the last successful backup, its size and duration, and warns when the last run failed.

## Milestone 3: Admin and deploy polish

1. **Clear "Update database" action**: when migrations are pending, the admin overview shows a prominent button (not a small link) with the list of migrations and the automatic backup that runs first. Non-primary admins see who can run it.
2. **No lost clicks during hydration**: buttons that start server actions are disabled until the page is interactive, so an early click is never silently ignored. Test: e2e clicks immediately after navigation.
3. **Layout preferences follow the account**: reading layout, density, list width and conversation view are saved to the account (with `localStorage` as the cache), so they carry over to other devices.

## Milestone 4: Security hardening

1. **HTML sanitizing with an allowlist (shipped in [#51](https://github.com/midego1/kite/pull/51))**: sanitize stored and displayed email HTML with DOMPurify (or an equivalent that runs on Workers) in addition to the sandboxed frame. Test: unit tests with known XSS payloads. Stored mail is cleaned with htmlparser2 in `parseRawMime`, display goes through DOMPurify; see [SECURITY.md](SECURITY.md#email-html).
2. **Secret scan before going public (done)**: scan the full git history for keys and personal data; document the result in `SECURITY.md`. Result: no secrets on `main`, two known synthetic test values on old pull request refs, and the maintainer's address only in commit metadata; see [SECURITY.md](SECURITY.md#history-scan).
3. **MCP over OAuth**: MCP clients can connect with OAuth 2.1 instead of a pasted API key, with the same per-scope tool filtering.

## Milestone 5: Agents

Automatic reading of incoming mail, with suggestions and an audit log (item 2), is specified in [docs/specs/auto-agent.md](docs/specs/auto-agent.md) and shipped in [#28](https://github.com/midego1/kite/pull/28); see [docs/assistant.md](docs/assistant.md).

1. **Email-addressable agents**: an address such as `assistant@your-domain` routes mail to the AI assistant, which can reply, file or draft within the permissions of its owner. Built on the existing routing rules and the agent queue; the Cloudflare Agents SDK is evaluated first. Specified as proposed [milestone 30](#milestone-30-assistant-by-email-proposed) in [docs/specs/assistant-by-email.md](docs/specs/assistant-by-email.md).
2. **Agent audit log**: every action an agent takes is recorded and visible to the mailbox owner, with undo where possible.

## Milestone 6: External mail accounts

Bring mail from Gmail, Outlook, iCloud and other providers into Kite, keep new mail arriving, and reply from the same address. Kite stays the place where the mail lives; the other provider is a source, not a mirror.

**Where it stands today.** Settings → Import copies one IMAP folder at a time as a background job (`src/lib/import/jobs.ts`, 200 messages per run), skips messages it already has by Message-ID, never marks anything read on the source server and erases the encrypted password when the job ends. Gaps:

- Every imported inbound message arrives unread, and stars are lost.
- One folder per job, so a full mailbox takes many manual runs.
- It is a one-time copy: mail that arrives at the other provider afterwards never shows up.
- Replies go out from a Kite domain, not from the imported address.
- It only runs on Workers. `src/lib/import/imap.ts` uses `cloudflare:sockets`, so an import fails on the Node/Docker runtime.
- Message bodies are stored in D1, which has a 10 GB limit per database, so a mailbox with many years of mail can fill it. Nothing warns before that happens.

**How each provider signs in**

| Provider | Sign-in | Works today |
| --- | --- | --- |
| Gmail (personal) | App password, needs 2-Step Verification | Yes |
| iCloud, Yahoo, AOL, Fastmail | App-specific password | Yes |
| Other IMAP hosts | Account password | Yes |
| Google Workspace | OAuth. Password sign-in ended in 2025; app passwords work only where the admin allows them | Partly |
| Outlook.com and Microsoft 365 | OAuth only. Microsoft retired password sign-in for IMAP (Outlook.com in 2024) | No |
| Proton Mail | Proton Mail Bridge, which runs on the user's own computer and cannot be reached from a Worker | No, out of scope |

Google treats full Gmail access (`https://mail.google.com/`) as a restricted scope: a public app needs Google's verification and a yearly security assessment. Kite does not ship one shared Google app. Each install registers its own in Google Cloud, which needs no verification when it is internal to a Workspace organisation or used by a few test users.

1. **Better import** (about 2 to 4 days)
   - Keep the read and starred state from the IMAP `\Seen` and `\Flagged` flags.
   - Import several folders, or the whole account, in one job, with Gmail's Sent, Spam, Trash and All Mail mapped to the matching Kite folders and progress shown per folder.
   - Before starting, show how many messages and roughly how much space the import needs, and warn when it would bring the database close to its limit.
   - Run on the Node/Docker runtime too, through Node's `net` and `tls` sockets behind the same interface.
   - Test: unit tests for flag and folder mapping in `src/lib/import/imap-utils.ts`; an e2e spec against a local IMAP test server checks read and starred state and a multi-folder job.
2. **Keep new mail arriving** (about 1 to 3 days, needs 1)
   - Documented path first: set up forwarding at the provider to a Kite address, with a routing rule that files it under a label for that account.
   - Optional polling: a scheduled job fetches new INBOX messages by IMAP UID since the last run. Unlike the one-time import, this keeps the encrypted password (or OAuth token) stored, so the account settings show that clearly and let the user remove it.
   - Test: unit tests for the "since last UID" bookkeeping; e2e checks that a message added to the test server appears after a poll and is not imported twice.
3. **Send as the external address** (about 3 to 5 days, needs 2)
   - The composer's From menu lists connected addresses. Mail goes out through that provider's SMTP submission server, so it passes the provider's SPF and DKIM, and a copy lands in Kite's Sent folder.
   - The address must be verified first (a code sent to it), so nobody can send as an address they do not own.
   - Test: e2e against a local SMTP test server checks the From header, the stored Sent copy and that an unverified address cannot be chosen.
4. **OAuth for Microsoft and Google** (about 3 to 5 days each, needs 1; send-as also needs 3)
   - Sign in with Microsoft (Outlook.com and Microsoft 365) or Google, then use XOAUTH2 for IMAP and SMTP. Refresh tokens are encrypted with `APP_ENCRYPTION_KEY` like the other stored secrets.
   - Admin settings take the client ID and secret of the install's own app registration, with setup steps in `docs/providers.md`.
   - Test: unit tests for the XOAUTH2 string and token refresh; manual check against a real test account, since CI has no provider credentials.

**Not planned: two-way sync.** Mirroring reads, moves and deletes back to the provider needs conflict handling, an always-open IMAP connection that Workers cannot hold, and per-provider quirks, for little gain once new mail arrives and replies go out from the right address.

## Milestone 7: Drive and storage

Files next to mail, on storage the operator chooses. Today every object (raw MIME, attachments, backups) goes through the one `BUCKET` binding with `get`, `put` and `delete`; the Node runtime already swaps R2 for a folder (`server/runtime/file-bucket.ts`), and `src/lib/aws/` already signs S3 requests. Items 1 to 3 are specified in [docs/specs/drive-storage.md](docs/specs/drive-storage.md), whose first Mission builds Drive on the existing storage and then adds S3-compatible stores; storing attachments once ([docs/specs/attachments-once.md](docs/specs/attachments-once.md)) comes after it and cuts mail storage by about a third.

1. **Storage providers**
   - R2 stays the default. An admin can add an S3-compatible store (AWS S3, Backblaze B2, Wasabi, Hetzner, MinIO, RustFS) behind the same interface. Credentials are encrypted with `APP_ENCRYPTION_KEY` and checked before saving, like the AWS settings.
   - Large uploads and downloads go straight between the browser and the store through short-lived signed URLs, so they are not limited by the Worker request size.
   - Test: unit tests for the S3 adapter against recorded responses; e2e against a local S3-compatible server.
2. **Drive (a module, on by default)**
   - Folders, upload, download, rename, move, trash, and share links with an expiry. An **All attachments** view lists files that arrived by mail.
   - Works out of the box on the storage every install already has (R2, or the file folder on Node). It is the module `drive`: the owner can turn it off under Admin → Modules or restrict it per user under Accounts → Permissions, and a per-user quota decides how much each person stores. When off, it is hidden and its API answers 404.
   - New tables go into the backup lists (see `AGENTS.md`); file contents stay in storage.
   - Test: e2e for upload, folders, sharing and the off switch, in Kite, Classic and dark mode.
   - Follow-up once Drive ships: Money Watch files every ledger document that has an attachment (including earlier ones) into the owner's Drive under `Finance/<vendor>/<year>/`, through a Drive filing service. The agreed behaviour and what Drive must provide are in [§24 of the Money Watch spec](docs/specs/money-watch.md#24-drive-filing-follow-up-after-drive-ships).
3. **Cold storage**
   - Raw mail, attachments and Drive files older than a chosen age move automatically to cheaper storage: R2's Infrequent Access class (through R2 lifecycle rules) or a second S3-compatible store (moved by a scheduled job that records where each object lives).
   - Opening a cold message or file fetches it from there with no extra step. The settings show what reading cold data costs: Infrequent Access bills every read and keeps objects for at least 30 days, and some archive classes (such as S3 Glacier Flexible Retrieval and Deep Archive) need a restore before an object can be read.
   - Optional: move message bodies of old mail out of D1 into storage to stay under its 10 GB limit, keeping the search index.
   - Test: unit tests for the age rules; e2e moves an old message and still opens and searches it.
4. **External storage** (needs 2)
   - WebDAV first (Nextcloud, ownCloud, most NAS), shown as a linked folder. Google Drive and OneDrive follow, each with the install's own OAuth app, as in milestone 6.
5. **Your own database** (self-hosted)
   - The database becomes pluggable like storage: a self-hosted install can run a hosted SQLite-compatible database (libSQL, Turso) instead of the local file, behind the existing `getDb()` seam. D1 on Cloudflare and the SQLite file in Docker stay the defaults; the dialect, the migration history and the FTS5 search index do not change.
   - Credentials are encrypted with `APP_ENCRYPTION_KEY` and checked before saving, like the AWS settings, and the admin overview shows which database and storage an install uses.
   - Not planned: Postgres and MySQL engines. SQLite is load-bearing (the D1 dialect, the hand-written migrations, every FTS5 index); a hosted SQLite service gives operators a managed database without rewriting the data layer.
   - Test: unit tests for the driver seam; an e2e run against a local libSQL server.

## Milestone 8: Sender screening

Mail from a sender you have not approved waits in a Screener instead of the Inbox, as in HEY. Off by default; turned on per mailbox under Settings → Inbox.

1. **Screener**
   - The first message from an unknown sender goes to a Screener view instead of the Inbox: no notification, no auto-reply and no agent run. The sidebar shows how many senders are waiting.
   - For each sender: **Yes** moves their waiting mail to the Inbox and lets future mail in; **No** sends future mail quietly to a Screened out folder. The sender is never told.
   - Decisions can be changed later under Settings → Screened senders.
   - Test: e2e delivers mail from a new sender and checks it lands in the Screener, that Yes moves it and the next message arrives in the Inbox, and that No sends the next one to Screened out.
2. **Who counts as known**
   - People you have written to, your contacts, and replies in threads you started skip the Screener. Turning screening on offers to approve everyone you already have mail from.
   - A whole domain can be approved or screened out at once.
   - Test: unit tests for the known-sender rules; e2e checks that a reply to your own message skips the Screener.
3. **Fits with the rest**
   - The spam filter runs first. On shared mailboxes, users with full access decide. The automatic reading agent skips screened mail and can suggest Yes or No.
   - Decisions live in a per-mailbox table that goes into the backup lists (see `AGENTS.md`). Works on Workers and the Node runtime.

## Milestone 18: Money Watch (subscription tracking)

Shipped in [#50](https://github.com/midego1/kite/pull/50), specified in [docs/specs/money-watch.md](docs/specs/money-watch.md). Automatic reading spots receipts, invoices, renewal and trial notices, refunds and failed payments, suggests tracking them, and reminds you before renewals, with a page at `/finance` listing every subscription, its totals and its documents. It is the first new builtin module on the module platform (milestone 19), with the module id `finance` and the display name Money Watch, so the owner can turn it off for everyone or per user. Suggestion-only: nothing is tracked until you accept, and every write can be undone. See [Modules](docs/modules.md) and [Assistant: automatic reading](docs/assistant.md#subscriptions-money-watch).

1. **Shipped**
   - Deterministic detection as a module triage step, including automatic and no-reply billing mail and the text of plain PDF invoices. A generic module model extension lets the step ask the existing triage request for missing fields (vendor, plan, amount, currency, cycle, dates, document type) under every existing gate; code validates them and they never override what the detector read or supply the cancel link, which comes only from `List-Unsubscribe`.
   - A reviewer-only `subscription` suggestion kind with Track, Record it (credits and refunds) and Mark urgent (failed payments), audited in `agent_actions` with undo; manual add by hand and from any message.
   - A document ledger: one entry per invoice, payment, credit note, refund or failed payment, linked to its message and attachment (a reference, never a copy), with a "paid in the last 12 months" total per currency.
   - Renewal and trial reminders from a module cron task: a realtime notice, the Subscriptions sidebar count and, through a new Calendar service, a calendar event.
   - The `list_subscriptions` tool, a search section, the `finance:subscription` record kind and the webhook events `finance.subscription.detected` and `finance.subscription.renewal_due`. Migration 0063; both tables are in the backup lists.
2. **Later**
   - One-off purchases and general expense tracking (a receipt with no subscription records nothing today).
   - Filing ledger documents into Drive automatically, once Drive ships (see milestone 7, item 2).
   - More events (`finance.subscription.updated`, `finance.document.recorded`), assistant write tools, `mailto:` cancel links and automatic updates from renewal invoices once an Act level exists.

## Milestone 19: Module platform (builtin modules first, sandboxed apps later)

Taken ahead of the proposed milestones 9–18 in the [complete-suite roadmap](docs/roadmap-complete-suite.md), with an approved [module platform spec](docs/specs/module-platform.md). Modules are built into Kite first; apps from other publishers come later as signed bundles that run sandboxed inside your own Kite, never on someone else's servers.

1. **Builtin modules (shipped in [#45](https://github.com/midego1/kite/pull/45))**
   - Calendar, Booking (needs Calendar), Email templates and Mail import become modules the owner can turn off for everyone or for some users, from Admin → Modules. Off means absent: no links, commands, tools, events or background work, and its pages and API answer 404. No data is deleted, mailbox export always works, and paused imports resume when Mail import is back on. See [Modules](docs/modules.md).
   - Core reaches modules only through a registry and one JSON call contract, and the assistant, automatic reading, MCP, API keys, JMAP, webhooks, search, For you, Activity, the command palette, the composer, the queues and cron read the registry instead of hard-coded lists. Same code path on Workers and the Node runtime.
   - Test: unit tests for the registry, the call contract, the import rules and the guards; `e2e/27-modules.spec.ts` turns every module off and on.
2. **Sandboxed apps inside your own Kite (later, separate spec)**
   - Signed bundles the owner installs, run in Dynamic Workers on Cloudflare or a workerd sidecar on Node and Docker, using the same capability descriptors and call contract as builtin modules, with owner-approved grants and network hosts.
   - An app directory, AI-suggested apps and paid listings follow once sandboxed apps exist.

## Milestone 20: Unified mailbox

One Inbox, Sent, Drafts and Archive for every mailbox you can open, so someone with several addresses (their own, shared ones and, after milestone 6, external accounts) reads and answers everything in one place. A single mailbox stays one click away.

**Where it stands today.** The mailbox selector shows one mailbox at a time. `/api/messages` already lists every accessible mailbox when no `mailboxId` is given, and the **All inboxes** unread count (used by the app badge) adds up all of them, but the UI has no view that uses it.

1. **All mailboxes view**
   - An **All mailboxes** entry at the top of the mailbox selector. It opens combined folders: Inbox, Starred, Snoozed, Sent, Drafts, Archive, Spam and Trash, with the sidebar counts summed across mailboxes. User folders stay per mailbox and are grouped under each mailbox's name.
   - Each row shows which mailbox it belongs to, as a small coloured label with the mailbox name or avatar (`src/lib/avatar-colors.ts`), so mail from different addresses is easy to tell apart. Conversation view groups threads per mailbox, never across them.
   - A filter narrows the view to some mailboxes, and the choice is remembered per browser (`appearance-preferences.ts`). Search, the command palette and keyboard navigation work in the combined view.
   - Test: e2e seeds two mailboxes, opens All mailboxes and checks both mailboxes' messages, labels and summed counts; filters to one mailbox and checks the other disappears.
2. **Acting on mail**
   - Reply, reply all and forward go out from the mailbox the message arrived in. A new message from the combined view asks for the From address, defaulting to the last one used. Bulk actions (read, archive, move, delete) work across mailboxes and move mail only within its own mailbox.
   - Moving to a user folder offers only the folders of that message's mailbox.
   - Test: e2e replies from the combined view and checks the From address and the Sent copy land in the right mailbox; a bulk archive over two mailboxes.
3. **Access and the rest of Kite**
   - The view contains only mailboxes the user can open (`listAccessibleMailboxes`), with each mailbox's access level applied per message: read-only shared mail cannot be moved or deleted from the combined view either. Admins see only the mailboxes they could open one by one.
   - Realtime updates, notifications, the For you page, automatic reading suggestions and rules keep working per mailbox. JMAP already lists every mailbox and needs no change.
   - No new table: the selection and filter are browser preferences. Works on Workers and the Node runtime.
   - Test: unit tests for the count summing and the per-message permission rules; an e2e test with a read-only shared mailbox.

## Milestone 27: AI writing (proposed)

Specified in [docs/specs/ai-writing.md](docs/specs/ai-writing.md); not yet approved. Ideas adopted from [Zero](https://github.com/Mail-0/Zero) (MIT), no code ported. Suggested order: first of milestones 27 to 30, after the approved [storing attachments once](docs/specs/attachments-once.md) and the "more chat actions" work in progress. Migration `0069` (renumber if another lands first).

1. **Editable prompts** (1–2 days): per-mailbox instruction fields for chat, drafting and the composer, and summaries, next to the existing instructions. Always in the system prompt below Kite's fixed rules, never inside the untrusted block, never replacing a prompt.
2. **AI in the composer** (3–4 days): write from a short prompt and rewrite a selection (shorter, longer, more formal, more casual, fix grammar, translate, custom), streamed into a preview, with the quote and signature untouched. No tools, nothing stored but usage, under the spend caps and rate limit.
3. **Writing style profile** (2–3 days): a statistical profile of how each user writes in each mailbox, built from sent mail in code (Welford means, top greeting and sign-off forms; no model), opt-in, with Reset, turned into a few lines for reply drafts, chat drafts and the composer.

## Milestone 28: Thread summaries (proposed)

Specified in [docs/specs/thread-summaries.md](docs/specs/thread-summaries.md); not yet approved. After milestone 27. Migration `0070`.

1. **Summarize in the reader** (3–4 days): a button for a conversation or a message, cached per mailbox, marked out of date when the conversation changes, never for spam, trash, screened mail or drafts.
2. **One-line summaries in the message list** (3 days): optional per mailbox, new mail only, never for suspicious or bulk mail unless allowed, made inside the automatic-reading triage request when there is one so no message is summarised twice, under every automatic-reading gate and cap.

## Milestone 29: Search by meaning (proposed)

Specified in [docs/specs/semantic-search.md](docs/specs/semantic-search.md); not yet approved. After milestone 28; before or together with large imports from milestone 6. Adds the Vectorize index `kite-messages`, which existing installs must create before the release that binds it. Migration `0071`.

1. **Spike** (1 day): Deploy-button provisioning, multilingual quality of `@cf/baai/bge-m3`, latency, and Node brute-force timings.
2. **Indexing** (4 days): triggers queue new, changed and deleted mail; a drain on the agent queue and cron embeds in batches with backfill limited to a share of the spend cap; vectors carry no content.
3. **Search** (3 days): FTS5 and vector results merged by reciprocal rank fusion and re-checked in D1 against the user's accessible mailboxes; a **By meaning** chip; `search_emails` gains `mode` in chat and MCP.
4. **Node and Admin** (2–3 days): vectors in a local SQLite file searched by brute force (sqlite-vec later if needed), Admin progress, pause and rebuild.

## Milestone 30: Assistant by email (proposed)

Specified in [docs/specs/assistant-by-email.md](docs/specs/assistant-by-email.md); not yet approved. Specifies milestone 5, item 1. After milestone 27 and the "more chat actions" work. Migration `0072`.

1. **Intake** (3 days): an assistant address per domain; DMARC, SPF and DKIM must pass from a trusted hop (Cloudflare Email Routing, the relay or SES); only the user's own or verified addresses; loop, auto-reply and replay guards; unknown senders dropped silently.
2. **Running and replying** (3–4 days): the chat engine with a read-only tool set plus drafts, send reviews and pending approvals; the reply carries a link to the answer in Kite and nothing else by default.
3. **Settings and extras** (2–3 days): verified extra addresses, an opt-in mode that includes the answer, the request list.
4. **SES and Node** (1–2 days): SES verdicts and the relay path; the direct SMTP listener and Resend are not supported.

## Ideas, not yet planned

- Offline reading with a service worker.
- A keyboard shortcut overview.
- Modules an admin can turn on or off (Drive, Calendar, Booking). Now [milestone 19](#milestone-19-module-platform-builtin-modules-first-sandboxed-apps-later); Drive will be a module (on by default) and storage stays core.
- ~~Extensions as separate services that use the API, webhooks and a sandboxed panel, so an extension cannot reach data it was not given. A directory of extensions would come later.~~ Superseded by milestone 19: modules are builtin first, and apps run sandboxed inside your own Kite later.
