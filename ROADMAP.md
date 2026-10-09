# Roadmap

Planned work, grouped into milestones. Each milestone is sized to run as one [Factory Mission](https://docs.factory.ai/cli/features/missions): it lists features with acceptance criteria, and every feature ends with the same validation. Items within a milestone are independent unless noted.

Shipped work is listed in the [changelog](CHANGELOG.md).

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

1. **HTML sanitizing with an allowlist**: sanitize stored and displayed email HTML with DOMPurify (or an equivalent that runs on Workers) in addition to the sandboxed frame. Test: unit tests with known XSS payloads.
2. **Secret scan before going public**: scan the full git history for keys and personal data; document the result in `SECURITY.md`.
3. **MCP over OAuth**: MCP clients can connect with OAuth 2.1 instead of a pasted API key, with the same per-scope tool filtering.

## Milestone 5: Agents

1. **Email-addressable agents**: an address such as `assistant@your-domain` routes mail to the AI assistant, which can reply, file or draft within the permissions of its owner. Built on the existing routing rules and the agent queue; the Cloudflare Agents SDK is evaluated first.
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

## Ideas, not yet planned

- Offline reading with a service worker.
- A keyboard shortcut overview.
