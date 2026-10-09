# Deployment and configuration

This guide covers Cloudflare deployment, runtime configuration, database backups, and application updates.

## Overview

Set up Kite in four steps:

1. **Create `CF_TOKEN`:** a Cloudflare API token Kite uses at runtime to manage DNS and Email Routing for your domains.
2. **Deploy the app:** use the Deploy to Cloudflare button and keep the app name `kite`.
3. **Complete setup:** open `/setup` on the deployed app to check the installation and create the first admin account.
4. **Connect your domain:** add a domain managed by the same Cloudflare account and choose which service receives its mail. Kite configures Email Routing and, when selected, Email Sending, then helps you create the first mailbox. Resend and Amazon SES are alternatives to Cloudflare for receiving and sending; see [Sending and receiving providers](providers.md).

## Step 1: Set up CF_TOKEN

Cloudflare does not pass its own deployment token to the app, so Kite needs a separate token.

1. In the Cloudflare dashboard, open **Manage Account → Account API Tokens** and create a custom token.
2. Add a policy for the zones you plan to connect (**Specified zones**, or **All zones** in the account) with these permissions:
   - **DNS & Zones → DNS: Edit**, so the confirmed setup flow can publish and replace MX records.
   - **DNS & Zones → Zone: Read**
   - **DNS & Zones → Zone Settings: Edit**
   - **Email & Messaging → Email Routing Rules: Edit**
3. If Kite will send mail through Cloudflare, add a policy for the account with **Email & Messaging → Email Sending: Edit**.
4. Create the token and copy its secret. You need it in step 2.

Sending through Cloudflare also needs a Workers paid plan and the domain on-boarded under **Compute → Email Service → Email Sending**. After setup, expand the domain under **Admin → Domains** to configure DKIM and DMARC.

Use only the token secret: not the word `Bearer`, and not the token ID. The token must belong to the same Cloudflare account as the domains you connect. To check it, see [Troubleshooting](troubleshooting.md).

## Step 2: Deploy Kite

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/midego1/kite)

1. Click **Deploy to Cloudflare** and sign in to Cloudflare if prompted.
2. Choose the Cloudflare account that owns the domain you want to use.
3. Keep the app name exactly `kite`. Email Routing rules and the Worker's binding to itself use that name, so another name breaks receiving mail. Cloudflare creates the database, bucket and queues.
4. When Cloudflare asks for secrets, enter:
   - `CF_TOKEN`: the token from step 1.
   - `SETUP_TOKEN`: a long random string of your own, for example from `openssl rand -hex 32`. Until the first admin exists, setup only runs with this token, so nobody else who finds the URL can claim the installation. Kite refuses the example value and anything shorter than 16 characters.
5. Start the deployment and wait for Cloudflare to finish.

Then, under the Worker's **Settings → Variables and secrets**, add:

- `APP_ENCRYPTION_KEY` (secret, recommended): another long random string that encrypts provider keys and webhook secrets stored in D1. Keep a copy: changing or losing it makes those values unreadable.
- `APP_URL` (variable): the app's public HTTPS address. Password reset links, and receiving through Resend or SES, need it.

## Step 3: Complete Kite setup

1. Open `/setup?setup_token=<your SETUP_TOKEN>` on the deployed Worker, or open `/setup` and enter the token when asked.
2. Let Kite check the Cloudflare configuration and initialize the empty D1 database.
3. Create the first admin account.

Setup applies the committed migrations through the Worker's D1 binding before creating the first admin account.

## Step 4: Connect your primary domain and create a mailbox

1. Enter a domain that already uses Cloudflare DNS on the same account as your `CF_TOKEN`.
2. Continue while Kite enables Email Routing and configures the routing and sending DNS records.
3. Choose the address for your first mailbox and finish setup.
4. Open the inbox and send a test message to the new address.

To connect more domains later, open **Admin → Domains**, select **New domain**, enter the hostname and choose the receiving service. With Cloudflare, Kite configures Email Routing and Email Sending automatically. With Resend or Amazon SES, add the provider's credentials and run its setup from the domain page; see [Sending and receiving providers](providers.md). `CF_TOKEN` is still needed in every case, because Cloudflare manages the domain's DNS.

Resend and SES receive mail by calling your app, so set `APP_URL` to the app's public HTTPS address before setting them up for receiving.

## Manual deployment

Install dependencies, configure the Cloudflare bindings in `wrangler.jsonc`, and run:

```bash
npm install
npm run deploy:local
```

The local deploy command builds with vinext and uploads the complete Worker with Wrangler. The Cloudflare Vite plugin generates `dist/server/wrangler.json` and redirects Wrangler to that build. It does not modify D1. The complete Worker is required because `worker.ts` also handles inbound email, queues, scheduled backups, and the real-time Durable Object.

For manual recovery, pending migrations can still be applied with:

```bash
npm run db:migrate:remote
```

The `database_id` in `wrangler.jsonc` is a default value: the Deploy to Cloudflare button replaces it with the ID of the database it creates in your account. For a manual deploy or remote migrations, set the ID of your own `kite` database.

## Database backups

Kite exports its D1 records as JSON and stores the backup files in the configured R2 bucket. A cron trigger in `wrangler.jsonc` runs daily at 02:00 UTC and applies the schedule selected under **Admin → Backups**. Manual backups run the same record export directly from the admin API.

Deploy the complete Worker with `npm run deploy` whenever the cron trigger is added or changed.

## Email assistant and MCP

The assistant uses the Workers AI `AI` binding and a separate `kite-agent` queue. The Deploy to Cloudflare button creates the queue; for a manual deploy, create it before deploying. The five-minute cron recovers pending auto-draft work; the 02:00 UTC cron still runs backups.

In the inbox, open **Assistant → Settings** for a mailbox, select its reviewer, and enable the assistant. Auto-drafting is a separate opt-in. It skips spam, automated mail, and mailboxes with out-of-office replies enabled. Generated replies appear as ordinary drafts assigned to the reviewer. The reviewer must open the draft and confirm the exact content before delivery.

The assistant panel no longer exposes MCP key management. External MCP clients can still connect to `https://<your-kite-origin>/mcp` with a mailbox-scoped Bearer key created through the authenticated `/api/agent/mcp-keys` endpoint. Keys can be listed and revoked through that endpoint; a new key is shown only once. The server uses Streamable HTTP and accepts clients that can set a Bearer header. Its `request_send` tool returns a Kite review URL; the MCP key cannot confirm or deliver messages directly. MCP does not require Workers AI for read and draft tools.

## Updating Kite

Deploy a new version the same way you deployed the first one: push to the repository connected to Cloudflare's Git integration, or run `npm run deploy`. Kite does not check for or pull updates by itself.

Deployment and database migration are separate. After Cloudflare deploys a new version, open or refresh **Admin settings**. The database card shows any pending database migrations. Select **Update database** to apply them through the Worker's D1 binding. The same runner initializes a new database during setup.

If the Cloudflare dashboard has a custom deploy command containing `wrangler d1 migrations apply DB --remote`, remove that part and use `npm run deploy`.

Each migration and its `d1_migrations` history entry run in one D1 batch. If a migration fails, its changes are rolled back, the failed filename is shown, and it can be retried after the problem is corrected. Wrangler remains available as a manual recovery tool.

New application releases must remain compatible with the previous schema until an administrator applies their migrations. Prefer additive changes, keep old columns during the transition, and avoid making authentication or the admin settings page depend immediately on a newly added column. Plan a maintenance window for an incompatible schema change.

When adding a schema change, create a new uniquely named SQL file in `drizzle/migrations` and do not edit an applied migration. Build and development commands generate the Worker migration bundle from those files. `npm run db:bundle` can generate it explicitly.

## Try a branch before it goes live

A [Worker Preview](https://developers.cloudflare.com/workers/previews/) runs a branch's code on its own address, such as `<branch>-kite.<subdomain>.workers.dev`, while production keeps running `main`. The `previews` block in `wrangler.jsonc` points Previews at the production database, R2 bucket and queues, so you sign in with your usual account and see your real domains, mailboxes and mail.

One-time setup in the Cloudflare dashboard, under **Workers & Pages → kite → Settings**:

1. **Builds**: in the **Set up Worker Previews** banner, select **Set up** and then **Switch to Worker Previews**. This cannot be undone. Under **Branch control**, keep **Enable Preview Builds** on, and make sure the build command is `npm run build` so the Preview command finds the built Worker.
2. **Variables and secrets**: choose **Previews Base** and import the variables from production. Secrets are not copied, so add them again with the same values. `APP_ENCRYPTION_KEY` must match production exactly, or the Preview cannot read stored provider keys. Add `CF_TOKEN`, and `TURNSTILE_SECRET_KEY` or `AI_API_KEY` if production has them.

After that, every push to a branch other than `main` builds a Preview, and the Preview URL appears under the Worker's deployments. You can also run `npx wrangler preview` from a branch on your own machine.

A Preview works on production data, so treat it as production:

- Mail you send, delete or move there really is sent, deleted or moved. Work the Preview queues, such as scheduled sends, imports and webhook retries, runs on the production Worker.
- Never select **Update database** in a Preview. A branch with new migrations would apply them to the production database. Test those with a copy of the database instead.
- Incoming mail, cron jobs and queue processing stay on production. The Preview has its own realtime connection, so new mail appears after a refresh rather than live.
- The Preview URL is public, behind the normal Kite sign-in. Protect it with [Cloudflare Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/) if you want a second gate. If production uses Turnstile, add the `workers.dev` hostname to the widget's allowed hostnames. If `APP_URL` is set for Previews, MCP clients can only connect to that address.
