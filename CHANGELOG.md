# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [calendar versions](https://calver.org/), `YYYY.MM.DD.N`: the UTC date a release was prepared and a counter for that day's releases, starting at 0 (see [Releasing](docs/releasing.md)).

## [Unreleased]

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
