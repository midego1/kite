# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [calendar versions](https://calver.org/), `YYYY.MM.DD.N`: the UTC date a release was prepared and a counter for that day's releases, starting at 0 (see [Releasing](docs/releasing.md)).

## [Unreleased]

Apply database migration 0062 after deploying, from the database card on the admin overview or the banner in the mailbox. It adds the module switches, per-user module access, booking appointment links and the calendar search index. Until it is applied, every module stays on for everyone and search finds no calendar events. No new settings or bindings.

### Added

- **Modules** under [Admin → Modules](/modules), for the owner only: turn Calendar, Booking, Email templates and Mail import off for everyone, or for some users under Accounts → Permissions. A module that is off disappears from navigation, the command palette, assistant chat, MCP, webhooks and search, and its pages and API answer 404. Nothing is deleted, mailbox export always works, and paused imports continue when Mail import is turned back on. Booking needs Calendar. A change reaches other open sessions within 30 seconds. See [Modules](https://github.com/midego1/kite/blob/main/docs/modules.md).
- Search finds calendar events: while you type in the search field, a dropdown lists matching events under **Events**, and choosing one opens it in Calendar. Enter still searches your mail.
- Webhook events for calendars and bookings: `calendar.event.created`, `calendar.event.updated`, `calendar.event.deleted` and `booking.appointment.created`, each with a reference to the event or appointment. They are listed and sent only while their module is on.
- The command palette has commands for Calendar (open it, go to a date, new event), Booking (open it, open an event type, copy your booking link) and Mail import, plus For you, Activity, Settings and Export. It lists only the modules that are on for you. In assistant chat, the assistant can give you a link to any of these pages.
- A **Page not found** page with a link back to the inbox, for unknown addresses and for the pages of a module that is off.
- A **Send test code** button under [Settings → Inbox → Notifications](/settings/inbox), next to **Send test notification**. It shows a sample sign-in notification with a new six-digit code and a **Copy code** button, so you can check that clicking a code notification copies the code on this device. It is available while **Show one-time codes in notifications** is on.
- CodeRabbit and Greptile review comments on open pull requests are checked automatically: a GitHub Actions workflow runs Droid in CI to verify each finding against the code, commits the ones that hold up to the pull request branch (after `npm run check` and, for user-visible changes, the affected e2e spec) and replies to the incorrect ones with the reason. It needs the `FACTORY_API_KEY` repository secret once, and is off with the `CODERABBIT_ADOPT` Actions variable set to `off`. Both reviewers follow the same rules (`.coderabbit.yaml`, `greptile.json`), and `npm run review:scoreboard` compares them by how many of their findings were adopted, so the better one can be kept.

### Changed

- Pull request checks finish in about half the time: the end-to-end suite runs as ten parallel shards balanced by recorded test durations (`E2E_SHARD=N/10 npm run test:e2e:shard`, durations in `e2e/timings.json`) instead of four shards split by test count, and every CI job restores a cached `node_modules` (and the E2E jobs a cached Chromium) instead of installing it. Nothing is skipped.
- The notice that the database still needs updates now sits in the empty reading pane, next to "Select a message to read", with the **Apply now** button for the owner. While a message is open, on other pages and on a phone it shrinks to a one-line banner above the mailbox.
- Snooze no longer opens a separate window. In an open message, **Snooze** in the **More actions** menu expands in place; on a list row, the clock button opens a small panel next to it. Choosing **Tomorrow**, **Next week** or **Next month** snoozes right away and shows the exact time beside each choice; a date and time of your own still needs **Snooze**.
- The Admin menu is grouped by task: **Email** (Domains, Mailboxes, Routing), **People & access** (Accounts, Modules), **Integrations** (API keys, Webhooks), **AI** (Agent, AI usage) and **System** (General, Branding, Backups, Alerts, Activity). In Settings, Security, App passwords and API keys move to their own **Security** group.

### Fixed

- A browser tab left open for a long time no longer keeps every message you opened in memory. Kite now remembers the 100 most recently opened messages for instant re-opening and fetches older ones again when needed.

### Security

- Email HTML is sanitized with an allowlist twice. Received mail (delivery, mail import and JMAP `Email/import`) is cleaned before it is stored, so the API, JMAP, webhooks and exports never hand out scripts, event handlers, frames, forms or script links; layout, classes and images stay, and the raw message keeps the original. Mail stored before this release is unchanged. The reader, reply and forward quotes, signatures and drafts opened in the composer now go through DOMPurify with the same allowlist as before, on top of the sandboxed frame. Drafts written by another mailbox member, over JMAP or by the assistant are cleaned before the composer shows them.

## [2026.10.13.0] - 2026-10-13

No database migrations and no new settings or bindings.

### Fixed

- **Send test notification** under [Settings → Inbox → Notifications](/settings/inbox) shows a banner on every click. A second click while the previous test was still in the notification centre used to replace it silently, so nothing seemed to happen.

## [2026.10.12.1] - 2026-10-12

No database migrations and no new settings or bindings.

### Added

- A **Send test notification** button under [Settings → Inbox → Notifications](/settings/inbox). It shows a sample browser notification right away, so you can check that notifications reach this device before relying on them for new mail.
- Release notes can link straight to a setting: a link to an app page (such as `/settings/inbox`) in `CHANGELOG.md` opens that page from the **What's new in Kite** dialog.
- Roadmap: the Drive and storage milestone gains **Your own database** — a self-hosted install can run a hosted SQLite-compatible database (libSQL or Turso) behind the existing database seam, with D1 and the SQLite file unchanged — and the storage-provider list names RustFS next to MinIO.

### Changed

- Pull request checks finish faster: the end-to-end suite now runs as four parallel shards (`PLAYWRIGHT_SHARD=N/4`), each with its own dev server and database, next to the Mission validation and Node build jobs. Nothing is skipped; the longest spec file (`23-auto-agent`) is marked parallel so it spreads across shards.

## [2026.10.12.0] - 2026-10-12

No database migrations. New defaults to know: a per-user sending allowance of 100 messages an hour and 500 a day is on by default (`SEND_LIMIT_PER_HOUR`, `SEND_LIMIT_PER_DAY`).

### Added

- Haimaker.ai is the first AI provider option, with a live model catalog and the **Refer & Earn** code and sign-up link. Anthropic is also available through its native Messages API, with models loaded from Anthropic's API. Chinese model families in Haimaker's catalog, including DeepSeek, Qwen, GLM, Kimi and MiniMax, remain dynamically listed rather than hardcoded.
- One-time codes (sign-in, verification, 2FA) detected in new mail can be copied in one click: the browser notification leads with the code, shows a **Copy code** action where the browser supports actions and copies on a plain click elsewhere (a minimal `kite-sw.js` service worker is registered when notifications are enabled), the in-app new-mail popup and the message reader show the code with a **Copy code** button, and a clipboard that refuses an automatic copy falls back to a dialog with one more Copy. Settings → Inbox → Browser notifications has a per-browser switch to keep codes out of notifications. Codes are detected at delivery with conservative heuristics (English and Dutch), sent only to users who can access the mailbox, never stored in a column and never logged.
- The sidebar footer shows when this build was made ("Updated 12 Oct, 14:20", in your locale and time zone). Clicking it opens **What's new in Kite**, which renders the release notes bundled with the release.
- A banner in the mailbox when the deployed version is ahead of the database schema. It says how many database updates are waiting, warns that new email may not appear until they are applied, and lets the primary admin apply them without leaving the mailbox; everyone else is told to ask an administrator. Set `AUTO_APPLY_MIGRATIONS=1` to apply them automatically instead (see [Deployment](https://github.com/midego1/kite/blob/main/docs/deployment.md)).
- A queue message that fails while database updates are pending now waits longer before its next attempt, so applying them within that window still keeps the mail.
- A per-user sending allowance: 100 messages an hour and 500 a day by default, counted from `outbound_jobs`, answered with HTTP 429 when reached. Change or turn it off with `SEND_LIMIT_PER_HOUR` and `SEND_LIMIT_PER_DAY`. No database migration.
- The first-run setup check now validates `APP_ENCRYPTION_KEY`, `APP_URL`, the Worker name and `CF_TOKEN` (a live call to Cloudflare), refusing to continue on a missing or example encryption key or a rejected token and showing the rest as recommendations. `APP_ENCRYPTION_KEY` is now prompted for by the Deploy to Cloudflare button.
- `docs/sending-and-deliverability.md`: who can send, why Kite is not an open relay, the limits, and SPF, DKIM and DMARC for Cloudflare, Resend and Amazon SES.
- README: why Kite, a comparison with Cloudflare Email Routing alone and hosted inboxes, known limitations, a demo recording and a note on how Kite was built. A feature-request issue template, issue chooser links to Discussions, `SUPPORT.md`, a 1280x640 social preview image and `npm run demo:record` / `npm run social:preview`.

### Changed

- A password reset link is sent at most once a minute per account.

### Fixed

- Manual backups no longer stay "RUNNING" forever. A manual backup is queued and exported by the outbound queue consumer instead of running inside the admin request, where a ~50 MB database outlived the response timeout and the cancelled invocation left the row unfinished with no file and no way to delete it. A backup left queued or running for over 30 minutes is marked failed with "Backup was interrupted before it finished" by the five-minute cron and when the Backups page loads, and an interrupted backup can be deleted.
- Settings > App passwords can create app passwords again. The form now asks which mailboxes the app may use (all of them by default, up to 30) and sends them, and a refused request shows the server's reason instead of "Could not create a key".
- Saving AWS credentials that work but lack SES permissions now shows the missing permissions and the IAM policy to attach under the error, while the form is still open. The refusal now carries the policy, and the Domains page keeps the response body of a failed request.

## [2026.10.09.1] - 2026-10-09

No database migrations. Deploys that keep their own `wrangler.jsonc` need the new `BOOKING_RATE_LIMIT` rate limit binding from `wrangler.jsonc.example`.

### Added

- Roadmap milestone for Drive and storage: other S3-compatible stores, an optional Drive, automatic cold storage and external storage.

### Changed

- Patch and minor dependency updates, including the MCP server SDK 2.3.1, drizzle-orm 0.45.4, Tailwind CSS 4.3.3 and Vite 8.3.4.

### Fixed

- Opening a message while others are checked shows it in the reading pane and clears the selection, instead of keeping the selection pane in its place.

### Security

- Adding or removing a mailbox alias needs admin rights or the **Manage mailboxes** permission, and an alias can no longer take an address that already delivers to another mailbox (including use-all-domains addresses and dot or `+tag` variants).
- Domain routing rules can only be read and changed by an admin of the domain. Other users see a note under Settings → Rules and keep their own inbox rules.
- Regular-expression routing rules refuse nested repetition such as `(a+)+`, backreferences and patterns over 200 characters, the most common causes of runaway matching.
- JMAP `Email/set` needs full access to change or delete mail; delegates with send permissions can still edit and discard their own drafts. JMAP `Mailbox/set` needs full access to rename a folder and only touches folders that belong to the named mailbox.
- Public booking requests are limited to 5 per minute per IP (`BOOKING_RATE_LIMIT`).
- Dependencies with known vulnerabilities were updated (Wrangler, the Cloudflare Vite plugin, workerd, sharp, undici, brace-expansion and fflate). The remaining `npm audit` findings are in build and development tools only.

## [2026.10.09.0] - 2026-10-09

The first release of Kite. It started from [Mailflare by hieunc229](https://github.com/hieunc229/mailflare); the entries below describe what changed since then.

### Added

- The Kite name and logo, the Kite style (indigo and lavender, Manrope, Ms Madi script accents) as the default, and a Classic style under Settings → Inbox → Appearance.
- Optional preview before sending and configurable undo send.
- Reading pane beside or below the list, or full width, with three densities, chosen from the account menu.
- Undo for archive and trash, and a shared confirm dialog for destructive actions.
- IMAP imports run as background jobs.
- Personal **Max steps per question** setting for the email assistant (default 15, 3 to 30); the last step always produces an answer instead of another tool call.
- `count_emails` assistant and MCP tool that answers "how many" questions with one count.
- Webhook channel for operational alerts (Slack, Discord, ntfy or generic JSON), set up under Admin → Alerts with a **Send test alert** button. Email and webhook are tried independently with a timeout and one retry, so an alert still arrives when email sending is down.
- Banner on the dashboard for every admin while an operational alert is active, dismissable until the set of alerts changes.
- Worker Previews configuration, so a branch can be tried on its own address before it reaches `main` (see "Try a branch before it goes live" in `docs/deployment.md`).
- Redacted structured logs, request correlation and a relay health endpoint. Queue and inbound failures keep non-PII context; requests are logged only on errors, client errors and slow responses.
- Calendar versions (`YYYY.MM.DD.N`) from `VERSION`, shown with the commit in the sidebar and the database card and reported by MCP and the OpenAPI document. `npm run release:prepare` prepares a release.
- Contributing guide, security policy, code of conduct, roadmap, operator runbooks and this changelog.
- Playwright browser tests against an isolated local database, unit tests, coverage gates, quality checks (complexity, size, unused code, duplicates, import boundaries, bundle budgets), a reproducible development container and an optional pre-commit hook.
- Continuous integration, Gitleaks and Semgrep scans, an advisory pull request report, CodeRabbit review configuration and Dependabot updates.

### Changed

- Every feature is available without a license key; licensing and self-update were removed.
- Backups stream to R2 in parts, so large databases back up within Worker memory limits. A backup runs automatically before every migration and restore.
- Restores are validated first and roll back to the safety backup on failure.
- Folders open without a loading delay, and cached lists show on the first frame.
- Resizing the message list follows the mouse without lag.
- Message lists use indexes and cursor paging; large lookups are chunked under D1's parameter limit.
- MCP lists only the tools a key's scopes allow.
- The app is formatted with Prettier, type errors fail the Next.js build, and `noImplicitAny` is enabled.

### Security

- Sessions live only in an `HttpOnly` cookie, with central CSRF checks and a nonce-based Content Security Policy.
- Email HTML renders in a sandboxed frame without scripts; remote images are blocked until allowed.
- Provider keys and IMAP passwords are encrypted at rest with `APP_ENCRYPTION_KEY`.
- The alert webhook URL is encrypted at rest and never shown again after saving. It must use `https` and a public host, and is checked again before every send; `ALERT_WEBHOOK_ALLOW_INSECURE` allows `http` to loopback in development only.
- First-run setup in production refuses the example `SETUP_TOKEN` and tokens shorter than 16 characters, so a deploy that keeps the Deploy to Cloudflare default cannot be claimed by someone else.

### Fixed

- Starring a message from a conversation thread shows the correct state.
- Bulk actions, Clear selection and Empty Trash/Spam return to the folder list instead of re-opening the message that was open behind the selection, and a message that leaves the list no longer stays selected.
- Icon-sized buttons get their intended size.
- In dark mode, plain emails are shown in full on the page background.
- Cloudflare authentication errors explain how to verify an Account API token as well as a user token.
