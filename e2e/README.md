# End-to-end tests

Playwright tests that drive the real app (vinext on local workerd, D1, R2, Queues, the Durable Object) in Chromium.

## Running

```bash
npx playwright install chromium   # once per machine
npm run test:e2e                  # or: npx playwright test
npx playwright test e2e/04-compose.spec.ts   # one file
npx playwright test --ui          # interactive
```

Playwright starts its own dev server on port **3200** (`E2E_PORT` overrides it). Before starting it, `e2e/prepare-state.mjs` deletes `.wrangler/e2e-state`, regenerates the migration bundle and applies every migration with `wrangler d1 migrations apply DB --local --persist-to .wrangler/e2e-state`. The server runs with:

- `KITE_PERSIST_DIR=.wrangler/e2e-state`: `vite.config.ts` passes this to the Cloudflare plugin as `persistState`, so the suite never reads or writes your `.wrangler/state`.
- `KITE_VITE_CACHE_DIR=.wrangler/e2e-vite-cache`: a separate dependency cache, so the suite does not re-optimize dependencies under another running dev server (checkouts can share `node_modules`).

Neither variable changes anything when it is unset. No Cloudflare credentials are needed. The seeded `example.com` domain uses the `manual` zone id, so creating accounts and mailboxes on it skips the Cloudflare API.

`e2e/global-setup.ts` then calls `POST /api/seed` (admin `admin@example.com` / `demo-password-change-me`, primary admin, 15 messages), signs in through the API and saves the session to `test-results/.auth/admin.json`. Every test starts from that session. It also opens each area of the app once, so Vite pre-bundles dependencies before the tests run instead of reloading the page in the middle of one.

When you run the suite over and over, `E2E_REUSE_SERVER=1` reuses a server that is already listening on 3200 instead of starting a fresh one. The database then keeps data from earlier runs, and the seed adds its messages again. Start that server with the same two environment variables, after running `KITE_PERSIST_DIR=.wrangler/e2e-state node e2e/prepare-state.mjs`.

## How the tests get mail

- **Inbound** mail is POSTed to Miniflare's local trigger, `/cdn-cgi/handler/email?from=…&to=…`, as raw MIME. It goes through the Worker's real `email` handler, R2, the inbound queue and the parser. `deliverInbound` in `support/helpers.ts` then polls `/api/messages` until the message is stored.
- **Outbound** mail goes through the local `send_email` binding, which accepts it without delivering anything. The tests check the `/api/send` response, the undo bar and the message reaching `sent` status.

## What it covers

| Spec | Flows |
| --- | --- |
| `01-auth` | Wrong password; sign in, reload, sign out (session revoked on the server); signing in again after the server revoked the session behind an open tab; foreign-origin and cross-site POSTs rejected with 403 (both the dev server's guard and the app's own CSRF check) |
| `02-navigation` | Sidebar Inbox, Starred, Sent, Snoozed, Drafts, Trash: client-side navigation (a `window` marker survives), URL and document title |
| `03-reading` | HTML in an iframe whose `sandbox` lacks `allow-scripts`, no script runs, remote images held back until **Show images**; in light and dark mode the frame declares its document's color-scheme (so its canvas stays transparent) and shows the whole message; a reply and its original shown as one conversation |
| `04-compose` | Settings > Inbox > Sending (preview + 10 s undo) through the UI, the preview dialog (recipient, subject, HTML in an iframe), Undo restores the composer, sending again reaches Sent exactly once; with the preview off, the message is sent directly |
| `05-organise` | Star and unstar; archive and trash with the Undo toast; Delete forever from Trash behind the confirm dialog (Cancel keeps the message, confirming deletes it) |
| `06-search` | Seeded subject found and the list narrowed; empty state for a query with no matches |
| `07-settings` | Sending settings saved to the account and still set after a reload; the assistant step limit is validated, 401s without a session, and (when the assistant is enabled) is edited in its Settings view and survives a reload |
| `08-team-shared-mailbox` | Admin creates two accounts (Admin > Accounts) and a shared mailbox (Admin > Mailboxes), and mail arrives in it. The teammate cannot see the mailbox before being granted access and can read its mail afterwards; the other account never sees it |
| `09-mcp` | MCP keys through `/api/agent/mcp-keys`: `initialize` reports the release in `VERSION`, a read-only key lists no draft, organise or calendar-write tools and `search_emails` finds and `count_emails` counts the seeded message, a draft-scoped key does list the draft tools, a bad key gets 401 |
| `10-backups` | Admin > Backups: back up, wait for `completed`, download the JSON; restore it and check that mail received after the backup is gone |
| `11-reading-pane` | Settings > Inbox > Reading layout: Right of inbox is the default, shows an empty reading pane on `/inbox` and keeps the same list element mounted when a message opens; No split and Below inbox; density changes row height |
| `13-security` | Without a session, every method of every `src/app/api/**/route.ts` (enumerated at run time with `routeMethods`) answers 401 or 403 unless `support/public-routes.ts` lists it with an exact status and a reason; none answers 500. `/api/realtime` answers 426 without `Upgrade` and refuses an unauthenticated upgrade; `/api/v1/*` rejects `Bearer invalid` with 401; `/login` and `/api/setup/status` carry the security headers; `ep_session` and `ep_accounts` are `HttpOnly`, `SameSite=Lax`, `Path=/` |
| `14-section-nav` | The Settings side menu: an admin gets the Settings \| Admin switch (Admin links to `/admin`) and only the Personal and Mailbox groups; the menu search finds admin pages under an "In Admin" heading (old Workspace names such as "members" still work), shows an empty message and restores the menu when cleared; the switch, search and links work from the keyboard with visible focus; a member gets no switch and no admin results, and a non-primary admin never gets primary-only pages. Admin pages use the same layout (mail sidebar, top bar, one `main`) with the menu in Admin mode: the Overview, Email, Administration and Product groups, each of the 14 links opening its page as the only current link (detail pages highlight Accounts or Mailboxes), the switch following the URL through Back and Forward, search finding Settings pages, Back to inbox and the top-bar mail search opening `/inbox`, the mailbox selector entries, `/admin` without link cards, a non-primary admin's reduced menu and blocked owner-only pages, a member kept out; on a 390x844 phone the pill opens the Admin menu sheet with the switch, page headings stay visible, content clears the pill and the menu button opens the mail sidebar |
| `15-alerts-settings` | Admin > Alerts (Administration group of the Admin menu, primary admin only): the page opens from the menu as the current link; saving a webhook URL shows only its masked host and survives a reload, Remove clears it and disables Send test alert; an http URL to a public host and a private address are refused inline; the detected format is shown and a chosen Format is saved; the webhook API refuses anonymous callers |
| `16-alerts-test-button` | Send test alert posts to a receiver started inside the spec and reports delivery; a receiver answering 500 shows the failure with its HTTP status and without the response body |
| `17-alerts-banner` | A stuck outbound job fixture makes the Operational alerts banner appear for an admin; Dismiss keeps it hidden across reloads; no banner once nothing is active; returning to the dashboard refreshes cached alerts without a reload; a regular user never requests active alerts |

The specs share one database, so they run one at a time in a single worker, in file order (`10-backups` restores the database, so the specs after it only make anonymous calls). Each test creates the data it changes, using a unique token in the subject.

### Security spec notes

- A new route that is not behind a session fails `13-security` and is listed with its status. Fix the route, or add it to `PUBLIC_ROUTES` in `support/public-routes.ts` with the exact status it answers and the reason it is public. `POST /api/seed` is skipped because it reseeds the database.
- The `Secure` cookie flag is set only when the request is served over https (production). The e2e server uses plain http, so the spec asserts that `Secure` is absent here.
- The Vite dev server closes the socket when the Worker answers an unauthenticated `/api/realtime` upgrade with 401, so the spec treats a closed connection as that 401.
- `.github/workflows/dast.yml` runs a weekly, report-only OWASP ZAP baseline (`-I`, rules in `.zap/baseline.conf`) against this same server. It is not a required check; the HTML and JSON reports are uploaded as an artifact.

## Writing tests

- Prefer `getByRole`, `getByLabel` and `getByText`. Wait for UI state or network responses rather than for time.
- In message lists, open a message with `openMessage(page, subject)`. Row links use `display: contents`, so clicking the link itself lands on the star button.
- Use `apiContext(STORAGE_STATE)` for API calls as the admin. It sends the `Origin` header that session mutations need.
- Tests that sign out or sign in as someone else need a fresh context (`test.use({ storageState: { cookies: [], origins: [] } })` or `browser.newContext`), so the shared admin session stays valid.
