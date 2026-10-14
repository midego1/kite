<img src="/public/kite.svg" alt="Kite" width="72" />

# Kite

**Kite is a self-hosted email inbox for your own domains that runs in your own Cloudflare account.** It receives mail through Cloudflare Email Routing and sends through Cloudflare, **Resend** or **Amazon SES**. Open source, AGPL-3.0, with every feature free.

[![Status: early beta](https://img.shields.io/badge/status-early%20beta-f59e0b)](#known-limitations)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-4f46e5)](LICENSE)

> **Based on [Mailflare](https://github.com/hieunc229/mailflare) by hieunc229.** Kite is an independent fork under the same AGPL-3.0 license. The foundation is theirs, and the original copyright notices and credits are kept in [NOTICE](NOTICE) and [Credits](#credits). See [How this version differs](#how-this-version-differs).

> **Status: early beta.** Kite is young. It works, it is tested, and a handful of things are still rough or missing (see [Known limitations](#known-limitations)). Please try it and [tell us where it breaks](https://github.com/midego1/kite/issues/new/choose).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/midego1/kite)

![A short tour of Kite: opening a message, replying with a send preview and undo, the calendar and the domain DNS checks](/docs/assets/demo.gif)

The recording shows invented demo data. `npm run demo:record` makes it again (see [Screenshots](#screenshots)).

## Why Kite

Kite is for developers, indie founders and small teams who already keep domains on Cloudflare and want a real inbox for `you@yourdomain` without paying per seat or running a mail server. It is also for self-hosters who want hackable email with an API.

- **Your mail, your account.** Messages live in your own D1 database and attachments in your own R2 bucket. There is no update check, license check or telemetry.
- **No server to run.** It deploys with one button to Cloudflare Workers. Receiving through Email Routing is free, and sending uses the free tiers of Resend or Amazon SES, or Cloudflare's own sending on a paid Workers plan. A Docker and SQLite path exists if you would rather run it on a box ([Self-host with Docker](#self-host-with-docker)).
- **A real inbox, not just forwarding.** Shared mailboxes, search, folders, snooze, undo send, routing rules, a calendar with booking pages, JMAP, an API, webhooks and MCP.

**Not for you (yet) if** you need a native mobile app, an interface in another language, a standard IMAP/SMTP server for desktop mail clients, or a setup with no manual steps. Teams with strict compliance needs should evaluate Kite carefully first.

### Kite compared with the alternatives

| | **Kite** | **Mailflare** (the upstream project) | **Cloudflare Email Routing alone** | **Hosted inboxes** (Google Workspace, Fastmail, Proton, Zoho and others) |
| --- | --- | --- | --- | --- |
| What it is | A fork of Mailflare that runs in your Cloudflare account, developed independently | The original self-hosted inbox by hieunc229 | Forwards mail for your domain to an address or a Worker | A managed mailbox service |
| Inbox and webmail | Yes | Yes | No, forwarding only | Yes, mature, with mobile apps |
| Sending as your domain | Cloudflare, Resend or Amazon SES, per domain | Cloudflare, Resend or Amazon SES | No sending inbox | Yes |
| Where your mail lives | Your D1 database and R2 bucket (or SQLite and local files with Docker) | Your Cloudflare account | Passes through, then lives wherever you forward it | The provider's servers |
| Price model | Free software, every feature included. You pay your own Cloudflare and provider usage | AGPL-3.0 core, with Pro and Team features behind a paid license key | Free | Per user per month |
| Interface languages | English only | Lists 33 languages in its README | Not applicable | Usually many |
| Community and maturity | Young project, small community | The original, with a much larger community and its own project site | A Cloudflare product | Established products with support teams |
| You run it | Yes: you deploy, update and back it up | Yes | Nothing to run | Nothing to run |
| Deliverability help | Documentation only ([guide](docs/sending-and-deliverability.md)) | Documentation | Not applicable | The strongest of these: support, reputation management and spam filtering at scale |
| Best when | You want an inbox you control, with an API and no license keys | You want the original project or a multilingual interface | You only need forwarding | You want polish, mobile apps and someone else on call |

Kite builds on Email Routing rather than replacing it: Cloudflare still delivers inbound mail and manages your DNS. Choose Email Routing alone if forwarding is enough, a hosted inbox if you value polish, mobile apps and support over control, and Mailflare if you want the upstream project. The feature-by-feature differences from Mailflare are under [How this version differs](#how-this-version-differs).

## Known limitations

Kite is **early beta**. It is tested, but it has not had the time in the field that older mail software has, and you run it, so you are responsible for updates, backups and your domains' reputation. What the code does and does not do today:

- **English-only interface.** There is no translation support yet; only right-to-left rendering of message content is planned first ([roadmap](ROADMAP.md)). Mailflare ships a multilingual interface.
- **Cloudflare is required for the default install.** The domain's DNS must be on Cloudflare (even when you send or receive through Resend or Amazon SES), you need an API token with several permissions, and the Worker must be named `kite`. The Docker build can run without Cloudflare credentials, but then you add DNS records by hand.
- **Cloudflare's own sending has limits.** It needs a paid Workers plan; messages are capped at 5 MiB including attachments (Kite sends larger files as download links), 50 recipients, with daily quotas that start low on new accounts, and Cloudflare describes it as intended for transactional mail. See [sending and deliverability](docs/sending-and-deliverability.md#provider-limits). Use Resend or Amazon SES for heavier sending. New Amazon SES accounts start in a sandbox that only delivers to verified addresses.
- **A per-user sending allowance.** By default 100 messages an hour and 500 a day per user, so a stolen session or key cannot send unlimited mail. It is configurable with `SEND_LIMIT_PER_HOUR` and `SEND_LIMIT_PER_DAY`.
- **One service owns a domain's MX records.** Receiving through Cloudflare, Resend or Amazon SES is a per-domain choice, and Kite asks before it replaces existing MX records.
- **Resend and SES receiving are more limited than Cloudflare's.** Mail that a routing rule would reject is dropped rather than bounced, and forward rules are not applied. Inbound messages are capped at 25 MiB.
- **No IMAP or SMTP server for desktop clients.** Standard mail apps cannot connect. Kite offers a web app, [JMAP](docs/api.md), an API, webhooks and MCP. IMAP is used only to import mail.
- **No native mobile app.** The web interface has a mobile layout.
- **Updates and migrations are manual.** Nothing updates itself: you deploy a new version, then apply database migrations from Admin settings.
- **No Wrangler D1 export.** `wrangler d1 export` does not work because of the search index; use the in-app backups.
- **No published third-party security audit.** The security measures are listed under [How this version differs](#how-this-version-differs), and vulnerabilities are handled as described in [SECURITY.md](SECURITY.md).
- **The sign-in limit is per IP address and API keys are not rate limited.** See [known gaps](docs/sending-and-deliverability.md#known-gaps).

## Screenshots

<table>
	<tr>
		<td align="center" valign="top" width="33.33%">
			<a href="/screenshots/inbox.png"><img src="/screenshots/inbox.png" width="250" alt="Inbox with a message open"></a><br><b>Inbox</b>
		</td>
		<td align="center" valign="top" width="33.33%">
			<a href="/screenshots/inbox-dark.png"><img src="/screenshots/inbox-dark.png" width="250" alt="Inbox in dark mode"></a><br><b>Dark mode</b>
		</td>
		<td align="center" valign="top" width="33.33%">
			<a href="/screenshots/compose.png"><img src="/screenshots/compose.png" width="250" alt="Replying to a message"></a><br><b>Reply</b>
		</td>
	</tr>
	<tr>
		<td align="center" valign="top" width="33.33%">
			<a href="/screenshots/calendar.png"><img src="/screenshots/calendar.png" width="250" alt="Week view of the calendar"></a><br><b>Calendar</b>
		</td>
		<td align="center" valign="top" width="33.33%">
			<a href="/screenshots/domains.png"><img src="/screenshots/domains.png" width="250" alt="Domain DNS checks"></a><br><b>Domain setup</b>
		</td>
		<td align="center" valign="top" width="33.33%">
			<a href="/screenshots/mailboxes.png"><img src="/screenshots/mailboxes.png" width="250" alt="Mailboxes on a domain"></a><br><b>Mailboxes</b>
		</td>
	</tr>
</table>

Click a screenshot to open it at full size. The screenshots and the demo recording show invented demo data. `npm run screenshots` takes the screenshots again against the same isolated, seeded server the browser tests use (`scripts/screenshots/readme.capture.ts`), `npm run demo:record` records the demo (`scripts/screenshots/demo.capture.ts`, needs `ffmpeg`), and `npm run social:preview` renders the 1280x640 repository social preview (`docs/assets/social-preview.png`).

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
- **Notifications**: Get live inbox updates and alerts when new mail arrives, and copy a one-time code straight from the notification.
- **Import, export, contacts**: Move mail in and out, manage contacts, and block unwanted senders.
- **Admin**: Manage users, permissions, API keys, webhooks, audit logs, and backups. Admin pages share the Settings layout, with the mail sidebar and one side menu that switches between Settings and Admin; there, the top-bar search field finds pages in both menus (on phones, the menu sheet has its own search), and audit logs are under Activity.
- **AI assistant**: Search your mail, draft replies, and manage calendar events with AI.
- **Automatic reading**: Let Kite read new mail and suggest replies, calendar answers, summaries and phishing warnings. Off by default, suggestions only, with spend caps and undo. See [Assistant: automatic reading](docs/assistant.md).
- **MCP access**: Connect AI clients over MCP, with separate permissions for each key.
- **Switchable modules**: Calendar, Booking pages, Email templates and Mail import are modules the owner can turn off for the whole install or per user, from the Modules admin page. What is off disappears from the menus, pages and APIs, and nothing is deleted. See [Modules](docs/modules.md).

## How this version differs

This version started from [Mailflare by hieunc229](https://github.com/hieunc229/mailflare) and no longer syncs with it. The main differences:

| | Original Mailflare | This version |
| --- | --- | --- |
| **Features** | Pro and Team features need a paid license key | Every feature is free; access is set by roles and mailbox sharing |
| **Updates** | Checks for and pulls updates from the original repository | No update check, license check or telemetry; a new version runs only after you deploy it. Apart from the services you configure, Kite contacts only Gravatar (contact avatars) and Cloudflare's public DNS resolver (DNS checks); see [Privacy](docs/privacy.md) |
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

You need a Cloudflare account with at least one domain whose DNS is on Cloudflare. Plan on about 10 minutes the first time. The steps in detail, with a troubleshooting table, are in the [deployment guide](docs/deployment.md).

1. **Create `CF_TOKEN`.** In the Cloudflare dashboard, open **Manage Account → Account API Tokens** and create a custom token (Cloudflare does not hand its deploy token to the app). Copy the secret, not the token ID, and no `Bearer`:
   - Zones you will connect (specified zones, or all zones): **DNS: Edit**, **Zone: Read**, **Zone Settings: Edit**, **Email Routing Rules: Edit**.
   - Account, only if Cloudflare will send mail: **Email Sending: Edit** (this also needs a paid Workers plan).
2. **Deploy the app.** Click **Deploy to Cloudflare**. Keep the app name `kite`: Email Routing rules and the Worker's self-binding use that name, and another name breaks receiving mail. Cloudflare creates the database, bucket and queues and asks for three secrets:
   - `CF_TOKEN`: the token from step 1.
   - `SETUP_TOKEN`: a long random string, for example from `openssl rand -hex 32`. It guards first-run setup.
   - `APP_ENCRYPTION_KEY`: another long random string. It encrypts the provider keys Kite stores. Keep a copy: losing or changing it makes them unreadable.
3. **Add `APP_URL`.** Under the Worker's **Settings → Variables and secrets**, add the variable `APP_URL` with the app's public HTTPS address, for example `https://kite.<your-subdomain>.workers.dev`. Password reset emails and receiving through Resend or Amazon SES need it. It cannot be asked at deploy time because the address does not exist yet; step 4 shows you the exact value.
4. **Finish setup.** Open `/setup?setup_token=<your SETUP_TOKEN>` on the deployed app. The first screen checks the install and tells you what is missing: a red item must be fixed (for example a `CF_TOKEN` Cloudflare rejects, which Kite proves with a live call, or an example `APP_ENCRYPTION_KEY`), an amber one is a recommendation (for example the `APP_URL` to add). Then create your admin account.
5. **Connect a domain.** Add a domain from the same Cloudflare account and choose which service receives its mail. Kite sets up Email Routing, or guides you through Resend or Amazon SES. Then create your first mailbox. Add Resend or AWS credentials on the domain page when you need them. Before sending real mail, read [sending and deliverability](docs/sending-and-deliverability.md) for SPF, DKIM and DMARC.

If something goes wrong in the first ten minutes, start with the troubleshooting table in the [deployment guide](docs/deployment.md#first-10-minutes-when-something-goes-wrong) and [Troubleshooting](docs/troubleshooting.md), then ask in [Discussions](https://github.com/midego1/kite/discussions) (see [SUPPORT.md](SUPPORT.md)).

### Deploy with an AI coding agent

Paste the prompt below into an agent with terminal access. Give it your Cloudflare account ID and **two separate scoped API tokens** through the agent's secret input. Never put them in a public chat, repository, or committed file.

- **Deployment token** (Wrangler uses it as `CLOUDFLARE_API_TOKEN`): scope it to the target account with **Workers Scripts Edit** (or **Workers Admin** if you see Cloudflare's newer roles), **D1 Edit**, **Workers R2 Storage Edit**, **Queues Edit**, and **Account Settings Read**. Add **Workers Routes Edit** for the target zone only if the agent should attach a custom domain or route. See Cloudflare's [token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) and [Workers roles](https://developers.cloudflare.com/workers/authorization/workers/).
- **Runtime token** (stored as the Worker secret `CF_TOKEN`): use the permissions above. It must cover the zones you will connect in Kite.

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
account-specific ID. Install dependencies,
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

Kite uses calendar versions, `YYYY.MM.DD.N`: the UTC date a release was prepared, then a counter for releases prepared that day, starting at 0. The sidebar and database card show the version from `VERSION` with the short Git revision, for example `2026.10.09.0 (985434d)`; a build between releases shows the last release with its own revision. The revision comes from Cloudflare/GitHub build metadata or the local Git checkout, and displays `unknown` when neither is available. The sidebar footer also shows when the build was made and opens the release notes bundled with it. See [Releasing](docs/releasing.md).

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

### Checks and CI

Use the development container or `npm run setup:mission` to prepare a development machine, and `npm run check:mission` to run everything CI runs: type checks, lint, unit and coverage gates, quality and docs checks, the relay integration test and the Playwright browser tests, including a security spec that checks every API route answers 401 or 403 without a session. See [Mission readiness](docs/mission-readiness.md) and [Contributing](CONTRIBUTING.md).

GitHub workflows also run the security scans, draft a release from `v*` tags, record Workers Builds results as deployments, run a weekly report-only ZAP scan and post an advisory report on every pull request.

## Built with

- **App**: Next.js App Router with React 19, running on Cloudflare Workers through [vinext](https://github.com/cloudflare/vinext) (Vite). The Docker build runs the same app on Node.
- **UI**: Tailwind CSS v4 with [shadcn/ui](https://ui.shadcn.com) components (Radix primitives, "new-york" style), Lucide icons and TanStack Query.
- **Data**: Drizzle ORM on Cloudflare D1 (SQLite in Docker), R2 for messages, attachments and backups, Queues for mail processing, and a Durable Object for live updates.
- **Tests**: `node:test` unit tests and Playwright browser tests (`npm run test:e2e`).

## Documentation

- [Deployment and configuration](docs/deployment.md)
- [Privacy and data handling](docs/privacy.md)
- [Sending and receiving providers (Cloudflare, Resend, Amazon SES)](docs/providers.md)
- [Sending and deliverability: who can send, abuse protection, SPF, DKIM and DMARC](docs/sending-and-deliverability.md)
- [Spam protection for incoming mail](docs/spam-protection.md)
- [API and integrations](docs/api.md), including the [calendar and booking APIs](docs/api.md#calendar-and-booking)
- [Email assistant and MCP](docs/email-assistant-and-mcp.md)
- [Modules: turning Calendar, Booking, templates and import off](docs/modules.md)
- [Operations](docs/operations.md), including [after a deploy](docs/operations.md#after-a-deploy)
- [Troubleshooting](docs/troubleshooting.md)
- [Roadmap](ROADMAP.md) and [changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md), [getting help](SUPPORT.md) and [security policy](SECURITY.md)

## How this was built

Kite is developed with AI coding assistants as well as by hand. The repository contains the instruction files those tools read ([CLAUDE.md](CLAUDE.md) and [AGENTS.md](AGENTS.md)), and some commits are co-authored by AI agents (the history shows `factory-droid[bot]`, and an automated reviewer, [CodeRabbit](https://coderabbit.link/midego) (referral link), comments on pull requests). Every change goes through the same gates, whoever wrote it: strict TypeScript, lint, unit tests and browser tests in CI, and a human review before anything is merged to `main`, which deploys production. AI-written code can still contain mistakes, so please report anything that looks wrong.

## License

Kite is licensed under the GNU Affero General Public License v3.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Every feature is included; there are no paid plans or license keys. If you run a modified version for other people, the AGPL requires you to offer them its source; the app links to it from the sidebar.

## Credits

Originally based on Mailflare by hieunc229 (https://github.com/hieunc229/mailflare), AGPL-3.0; substantially extended since.
