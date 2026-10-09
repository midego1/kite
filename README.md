<img src="/public/kite.svg" alt="Kite" width="72" />

# Kite

Kite is a self-hosted email inbox for custom domains, built on Cloudflare. It sends and receives through Cloudflare, **Resend** or **Amazon SES**.

Kite is an independent, fully open fork of [Mailflare by hieunc229](https://github.com/hieunc229/mailflare) under the same AGPL-3.0 license: every feature is free, there are no license keys, and it focuses on speed, security and reliability. See [How this version differs](#how-this-version-differs) and the [roadmap](ROADMAP.md).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/midego1/kite)

## Mission development

Use the development container or `npm run setup:mission` to prepare a worker.
Run `npm run check:mission` to validate the app and email relay, including
local integration checks and browser QA. See the [Mission readiness guide](docs/mission-readiness.md).
It also enforces the app coverage gate, the task-marker policy (such markers need an issue link),
the freshness of [docs/openapi.json](docs/openapi.json) (the OpenAPI spec for `/api/v1`) and the
security e2e spec that checks every API route answers 401/403 without a session.

After a deploy, follow [After a deploy](docs/operations.md#after-a-deploy) to check the Analytics
Engine metrics and the operational alerts: emails to the primary admin, an optional webhook to Slack,
Discord, ntfy or any JSON endpoint (Admin → Alerts), and a banner for admins (set
`OPERATIONAL_ALERTS=off` to disable them; see [Operational alerts](docs/operations.md#operational-alerts)). Besides CI, docs and security scans, GitHub workflows draft a release from `v*`
tags, record Workers Builds results as deployments, run a weekly report-only ZAP scan, and post an
advisory PR report.

## Screenshots

| ![Inbox](/screenshots/1.png)<br>Inbox | ![Manage domains](/screenshots/2.png)<br>Manage domains | ![Manage inboxes](/screenshots/3.png)<br>Manage inboxes |
| --- | --- | --- |

## What you can do

- **Domains**: Connect your Cloudflare domains and choose Cloudflare, Resend, or Amazon SES for each.
- **Mailboxes**: Create personal or shared mailboxes and give other people access to them.
- **Email**: Send and receive mail with attachments, rich text, signatures, and automatic replies.
- **Calendar**: Day, week and month views. Schedule repeating events with time zones and attendees, who receive email invitations.
- **Booking pages**: Share a public link so anyone can book a free time on your calendar.
- **Reading layout**: Read with the list beside or above the open email, or full width, in default, comfortable or compact density.
- **Safer sending**: Preview an email before it goes out and undo a send for a few seconds afterwards.
- **Organization**: Keep your inbox tidy with search, folders, stars, snooze, archive, spam, and trash, with undo for archive and trash. After a bulk action you return to the message list with the selection cleared.
- **Routing rules**: Store, forward, reject, or sort incoming mail automatically.
- **Notifications**: Get live inbox updates and alerts when new mail arrives.
- **Import, export, contacts**: Move mail in and out, manage contacts, and block unwanted senders.
- **Admin**: Manage users, permissions, API keys, webhooks, audit logs, and backups. Admin pages share the Settings layout, with the mail sidebar and one side menu that switches between Settings and Admin; there, the top-bar search field finds pages in both menus (on phones, the menu sheet has its own search), and audit logs are under Activity.
- **AI assistant**: Search your mail, draft replies, and manage calendar events with AI.
- **MCP access**: Connect AI clients over MCP, with separate permissions for each key.

## How this version differs

This version started from [Mailflare by hieunc229](https://github.com/hieunc229/mailflare) and no longer syncs with it. The main differences:

| | Original Mailflare | This version |
| --- | --- | --- |
| **Features** | Pro and Team features need a paid license key | Every feature is free; access is set by roles and mailbox sharing |
| **Updates** | Checks for and pulls updates from the original repository | Never phones home; you deploy from your own repository |
| **Email display** | Email HTML inserted directly into the page | Sandboxed frame with no scripts; remote images blocked until you allow them |
| **Sessions and requests** | Session token also kept in `localStorage`; CSP allows inline scripts | Session only in an `HttpOnly` cookie, central CSRF checks, nonce-based CSP |
| **Stored secrets** | Provider keys stored as plain text | Provider keys and IMAP passwords encrypted with AES-GCM (`APP_ENCRYPTION_KEY`) |
| **Sending** | Sends immediately | Optional preview before sending and undo send |
| **Reading** | Optional two-column view | Reading pane beside or below the list, or full width; density options; smooth resizing |
| **Backups** | Whole database built in memory as one JSON document | Streamed to R2 in parts, so large mailboxes back up within Worker limits; automatic backup before every migration and restore |
| **Restore** | Deletes the current data, then inserts the backup | Validated first; a failed restore rolls back to the automatic safety backup |
| **MCP** | Every tool listed for every key, fixed version `0.1.0` | Only the tools a key's scopes allow; reports the real app version |
| **Quality** | Unit tests, no CI or browser tests | Strict TypeScript, lint, over 300 unit tests and over 70 browser tests on every push |

### Performance

Measured on a production build in a plain Chrome profile:

| | Before | Now |
| --- | --- | --- |
| Opening a folder for the first time | ~340 ms with an empty page and loading bar | ~35–50 ms |
| Returning to a folder you already opened | Empty list, then the messages | Messages on the first frame (~20–35 ms) |
| Dragging the divider between list and email | Divider trails the mouse by ~90 px | Follows the mouse exactly |
| Backing up a 53 MB database | Fails: Worker exceeds its 128 MB memory limit | Completes |

Other changes behind those numbers:

- Database indexes for the common list, thread and search queries, and cursor-based paging instead of `OFFSET`.
- Large `IN (...)` lookups split into chunks that stay under D1's parameter limit.
- One shared, cached session lookup instead of one per component.
- Links prefetch on hover, and the assistant panel and composer load only when you open them.
- A daily cleanup job prunes expired sessions, old webhook deliveries and other short-lived rows.
- IMAP imports run as background jobs with bulk fetching and a buffer that does not slow down on large messages.

## How it works

Kite runs in your Cloudflare account. By default, Cloudflare Email Routing delivers incoming mail to the app, and Cloudflare's email service sends outgoing mail. Each domain can also receive or send through Resend or Amazon SES. Cloudflare still manages the DNS.

Your mail stays in your own D1 database, and attachments stay in your own R2 bucket, whichever provider you use. See [Sending and receiving providers](docs/providers.md).

## Cost

**You can set up Kite, receive mail, and send mail for free.** Receiving with Cloudflare Email Routing is free. For sending, use the free tier of Resend or Amazon SES. Cloudflare's own email sending needs a paid Worker plan.

| Send with | Free tier | After that |
| --- | --- | --- |
| **Resend** | 3,000 emails a month (100 a day), 3 domains | From $20/month for 50,000 emails |
| **Amazon SES** | $200 AWS credit for new accounts (about 2 million emails). The free plan lasts 6 months and credits expire after 12. | $0.10 per 1,000 emails |
| **Cloudflare Email Sending** | None | Needs a [Paid Worker](https://developers.cloudflare.com/workers/platform/pricing/) plan ($5/month) |

Receiving costs:

- Cloudflare Email Routing: free.
- Resend: included in every plan.
- Amazon SES: $0.10 per 1,000 messages, plus small S3 and SNS charges.

New SES accounts start in a sandbox that only delivers to verified addresses. Request production access in the AWS console to lift this.

You choose the provider per domain and can switch anytime (see [Sending and receiving providers](docs/providers.md)). Prices change, so check [Resend](https://resend.com/pricing), [Amazon SES](https://aws.amazon.com/ses/pricing/), and [Cloudflare](https://developers.cloudflare.com/workers/platform/pricing/) first.

## Deploy

1. **Deploy the app.** Click **Deploy to Cloudflare**. Keep the app name `kite`. Other Worker names will break the app. Cloudflare creates the database, bucket and queues and asks for `CF_TOKEN` and `SETUP_TOKEN` (any long random string).
2. **Finish setup.** Open the deployed app at `/setup?setup_token=<your SETUP_TOKEN>` to check the install and create your admin account.
3. **Connect a domain.** Add a domain from the same Cloudflare account and choose which service receives its mail. Kite sets up Email Routing, or guides you through Resend or Amazon SES. Then create your first mailbox. Add Resend or AWS credentials on the domain page when you need them.

⚠️ **`CF_TOKEN` is required during deployment.** Create a scoped [Cloudflare API token](https://dash.cloudflare.com/profile/api-tokens) with these permissions for the domains you want to connect:

- All accounts: Email Sending:Edit, DNS Settings:Edit, Email Routing Addresses:Edit
- All zones: DNS Settings:Edit, Email Routing Rules:Edit, Zone Settings:Edit, DNS:Edit

### Deploy with an AI coding agent

Paste the prompt below into an agent with terminal access. Give it your Cloudflare account ID and **two separate scoped API tokens** through the agent's secret input. Never put them in a public chat, repository, or committed file.

- **Deployment token** (Wrangler uses it as `CLOUDFLARE_API_TOKEN`): scope it to the target account with **Workers Scripts Edit** (or **Workers Admin** if you see Cloudflare's newer roles), **D1 Edit**, **Workers R2 Storage Edit**, **Queues Edit**, and **Account Settings Read**. Add **Workers Routes Edit** for the target zone only if the agent should attach a custom domain or route. See Cloudflare's [token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) and [Workers roles](https://developers.cloudflare.com/workers/authorization/workers/).
- **Runtime token** (stored as the Worker secret `CF_TOKEN`): use the domain permissions above. Add **Email Sending Edit** to send mail. It must cover the zones you will connect in Kite.

```text
Install Kite from https://github.com/midego1/kite in my Cloudflare account.
Ask me for my Cloudflare account ID, a scoped deployment API token, and a separate
runtime CF_TOKEN through a secret input. Never print, commit, or place either token
in a command argument or a tracked file. Use the deployment token only for Wrangler
authentication (CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID).

Read README.md, docs/deployment.md, and wrangler.jsonc first. Keep the Worker name
exactly kite. In the selected account, create or reuse the D1 database kite,
R2 bucket kite-raw, and Queues kite-inbound, kite-outbound, and kite-agent.
Set the D1 database_id in the local Wrangler config without committing that
account-specific ID, and remove the LEGACY_DB and LEGACY_BUCKET bindings. Install dependencies,
run npm run deploy, and set the runtime CF_TOKEN as a Worker secret. Do not run
remote D1 migrations manually; the /setup flow initializes the database.

Give me the deployed URL and any remaining Cloudflare account actions. I will
open /setup, create the first admin account, and connect my domain there.
```

See the [deployment guide](docs/deployment.md) for permissions, manual deployment, backups, and database migrations.

### Self-host with Docker

Kite also runs as one container on any server. It uses SQLite and local files instead of D1 and R2.

- **Inbound mail**: a built-in SMTP listener, or a small Cloudflare relay Worker if you want to keep MX on Cloudflare.
- **Outbound mail**: any SMTP relay, Cloudflare Email Sending, Resend, or Amazon SES.

Create a `.env.docker` file with the settings for receiving and sending mail described in [docs/self-hosting.md](docs/self-hosting.md), then start the container:

```bash
docker compose up -d --build
```

## Local development

The sidebar and database card report an automatically generated build version, `YYYY.MM.DD (commit)`, using the build date in UTC and the short Git revision. Worker and Node builds embed it at build time; there are no version-bump commits or update checks. The revision comes from Cloudflare/GitHub build metadata or the local Git checkout, and displays `unknown` when neither is available. `package.json` retains its package version.

```bash
cp .dev.vars.example .dev.vars
npm install
npm run db:migrate:local
npm run dev
```

Add your Cloudflare credentials to `.dev.vars`, then open [http://localhost:3000](http://localhost:3000). To load sample data, run `npm run db:seed` while the dev server is running.

The Cloudflare app uses vinext and the Cloudflare Vite plugin, with local D1, R2, Queues, and Durable Objects. Remote bindings are off by default. To use Workers AI locally, log in with Wrangler, set `CLOUDFLARE_ACCOUNT_ID`, and run `CLOUDFLARE_REMOTE_BINDINGS=true npm run dev`.

- `npm run build`: build the full Worker.
- `npm run start`: preview that build locally.
- `npm run deploy`: build and deploy.
- `npm run check`: type-check, lint and run the unit tests.
- `npm run check:mission`: everything CI runs, including coverage, quality and docs checks and the browser tests.
- `npm run test:e2e`: run the Playwright browser tests against an isolated local database.

The Node/Docker runtime still uses Next.js with `build:node`, `start:node`, and `dev:node`.

## Built with

- **App**: Next.js App Router with React 19, running on Cloudflare Workers through [vinext](https://github.com/cloudflare/vinext) (Vite). The Docker build runs the same app on Node.
- **UI**: Tailwind CSS v4 with [shadcn/ui](https://ui.shadcn.com) components (Radix primitives, "new-york" style), Lucide icons and TanStack Query.
- **Data**: Drizzle ORM on Cloudflare D1 (SQLite in Docker), R2 for messages, attachments and backups, Queues for mail processing, and a Durable Object for live updates.
- **Tests**: `node:test` unit tests and Playwright browser tests (`npm run test:e2e`).

## Documentation

- [Deployment and configuration](docs/deployment.md)
- [Moving an existing install to the Kite resources](docs/kite-migration.md)
- [Privacy and data handling](docs/privacy.md)
- [Sending and receiving providers (Cloudflare, Resend, Amazon SES)](docs/providers.md)
- [API and integrations](docs/api.md), including the [calendar and booking APIs](docs/api.md#calendar-and-booking)
- [Email assistant and MCP](docs/email-assistant-and-mcp.md)
- [Operations](docs/operations.md), including [after a deploy](docs/operations.md#after-a-deploy)
- [Troubleshooting](docs/troubleshooting.md)
- [Roadmap](ROADMAP.md) and [changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md) and [security policy](SECURITY.md)

## License

Kite is licensed under the GNU Affero General Public License v3.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Every feature is included; there are no paid plans or license keys. If you run a modified version for other people, the AGPL requires you to offer them its source; the app links to it from the sidebar.

## Credits

Originally based on Mailflare by hieunc229 (https://github.com/hieunc229/mailflare), AGPL-3.0; substantially extended since.
