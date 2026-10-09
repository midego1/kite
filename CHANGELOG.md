# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [calendar versions](https://calver.org/), `YYYY.MM.DD.N`: the UTC date a release was prepared and a counter for that day's releases, starting at 0 (see [Releasing](docs/releasing.md)).

## [Unreleased]

### Added

- Renamed to Kite, with a kite logo, the Kite style (indigo and lavender, Manrope, Ms Madi script accents) as the default, and a Classic style under Settings → Inbox → Appearance.
- `npm run typecheck`, `npm run test` and `npm run check` scripts.
- Continuous integration on GitHub Actions that type-checks, lints, tests and builds every pull request.
- Contributing guide, security policy, code of conduct and this changelog.
- Roadmap (`ROADMAP.md`) organised into milestones with acceptance criteria and validation steps.
- Optional preview before sending and configurable undo send.
- Reading pane beside or below the list, or full width, with three densities, chosen from the account menu.
- Undo for archive and trash, and a shared confirm dialog for destructive actions.
- Playwright browser tests (`npm run test:e2e`) against an isolated local database.
- IMAP imports run as background jobs.
- Personal **Max steps per question** setting for the email assistant (default 15, 3 to 30, migration `0058_add_agent_max_steps`); the last step always produces an answer instead of another tool call.
- `count_emails` assistant and MCP tool that answers "how many" questions with one count.
- Webhook channel for operational alerts (Slack, Discord, ntfy or generic JSON), set up under Admin → Alerts with a **Send test alert** button (migration `0059_add_alert_webhook`). Email and webhook are tried independently with a timeout and one retry, so an alert still arrives when email sending is down.
- Banner on the dashboard for every admin while an operational alert is active, dismissable until the set of alerts changes.
- Worker Previews configuration, so a branch can be tried on its own address against the production data before it reaches `main` (see "Try a branch before it goes live" in `docs/deployment.md`).

### Changed

- Every feature is available without a license key; licensing and self-update were removed.
- Backups stream to R2 in parts, so large databases back up within Worker memory limits. A backup runs automatically before every migration and restore.
- Restores are validated first and roll back to the safety backup on failure.
- Folders open without the Suspense loading delay, and cached lists show on the first frame.
- Resizing the message list follows the mouse without lag.
- Message lists use indexes and cursor paging; large lookups are chunked under D1's parameter limit.
- MCP lists only the tools a key's scopes allow and reports the real app version.
- Calendar versions (`YYYY.MM.DD.N`) from `VERSION`, prepared with `npm run release:prepare`. The sidebar, the database card, MCP and the OpenAPI document show the release instead of the build date.

### Security

- Sessions live only in an `HttpOnly` cookie, with central CSRF checks and a nonce-based Content Security Policy.
- Email HTML renders in a sandboxed frame without scripts; remote images are blocked until allowed.
- Provider keys and IMAP passwords are encrypted at rest with `APP_ENCRYPTION_KEY`.
- The alert webhook URL is encrypted at rest and never shown again after saving. It must use `https` and a public host, and is checked again before every send; `ALERT_WEBHOOK_ALLOW_INSECURE` allows `http` to loopback in development only.

### Maintenance

- Type errors now fail the Next.js build, and `noImplicitAny` is enabled.
- `ws` is declared as a runtime dependency of the self-hosted server instead of being pulled in transitively by a development dependency.
- The demo video is no longer stored in the repository.

### Fixed

- Starring a message from a conversation thread now shows the correct state.
- Bulk actions, Clear selection and Empty Trash/Spam return to the folder list instead of re-opening the message that was open behind the selection, and a message that leaves the list no longer stays selected.
- Icon-sized buttons now get their intended size.
- In dark mode, plain emails no longer sit in a black box with their last line cut off: the message frame now declares the same color-scheme as the message and has no padding outside its measured height.

## [0.5.0.1] - 2026-10-07

### Added

- Reproducible Mission setup with a tested Node development container and app/relay validation.
- Redacted structured logs, request correlation, and a relay health endpoint. Queue and inbound failures keep non-PII context (queue, message ID, attempts, kind, raw object key); requests are logged only on errors, client errors and slow responses.
- Quality checks for complexity, size, unused code, duplicates, boundaries, shared versions, and bundle budgets, with existing debt recorded for review.
- The repository is formatted with Prettier, and formatting is enforced without a baseline.
- An optional pre-commit hook for documentation and staged-file formatting, installed with `npm run hooks:install`.
- Scoped coverage thresholds, retained CI evidence, generated API inventory, operator runbooks, and security scans.
- Dependency-update automation, ownership rules, issue/PR templates, and a repository validation skill.

### Fixed

- The installed Next.js critical dependency advisory by updating Next and its ESLint configuration to 16.4.0.
- Development-container tests using an older Node version and unbounded waits for the relay's receiving server.
