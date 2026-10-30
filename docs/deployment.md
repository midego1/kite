# Deployment and configuration

This guide covers Cloudflare deployment, runtime configuration, database backups, and application updates.

## Overview

Set up Kite in four steps:

1. **Create `CF_TOKEN`:** a Cloudflare API token Kite uses at runtime to manage DNS and Email Routing for your domains.
2. **Deploy the app:** use the Deploy to Cloudflare button and keep the app name `kite`.
3. **Complete setup:** open `/setup` on the deployed app to check the installation and create the first admin account.
4. **Connect your domain:** add a domain managed by the same Cloudflare account and choose which service receives its mail. Kite configures Email Routing and, when selected, Email Sending, then helps you create the first mailbox. Resend and Amazon SES are alternatives to Cloudflare for receiving and sending; see [Sending and receiving providers](providers.md).

### Everything you have to provide

| Setting | Where | When | Notes |
| --- | --- | --- | --- |
| App (Worker) name `kite` | Deploy button's name field | Deploy | Must stay exactly `kite`. Email Routing rules and the Worker's binding to itself use that name, so a different name breaks receiving mail. The setup page warns when a `workers.dev` address does not start with `kite`. |
| `CF_TOKEN` (secret) | Deploy button | Deploy | Account API token, see step 1. Setup makes a live call to Cloudflare and shows a red error if the token is rejected. |
| `SETUP_TOKEN` (secret) | Deploy button | Deploy | A long random string, at least 16 characters, not the example value. Opens `/setup`. |
| `APP_ENCRYPTION_KEY` (secret) | Deploy button | Deploy | A long random string, at least 16 characters, not the example value. First-run setup in production stops until you replace the example. |
| `APP_URL` (variable) | Worker **Settings → Variables and secrets** | After the first deploy | The public HTTPS address, for example `https://kite.<your-subdomain>.workers.dev`. The setup page shows the exact value. Needed for password reset emails and for receiving through Resend or Amazon SES. |
| `SEND_LIMIT_PER_HOUR`, `SEND_LIMIT_PER_DAY` (variables) | Worker **Settings → Variables and secrets** | Optional | Per-user sending allowance, default 100 an hour and 500 a day; `0` removes a limit. See [Sending and deliverability](sending-and-deliverability.md#limits-and-abuse-protection). |
| `KITE_TELEMETRY` (variable) | Worker **Settings → Variables and secrets** | Optional | `0` (or `false`, `off`, `no`) turns usage statistics off for the deployment: nothing is sent, the setup switch is off and locked, no notice appears, and the owner cannot turn them on under **Admin → General** (only off). Without it statistics are on by default, explained in the first-run setup, and an existing install's owner gets a notice first, and reports start at the first 02:00 UTC run at least an hour after the owner saw it. No value turns them on. See [Privacy](privacy.md#usage-statistics). |
| `KITE_TELEMETRY_URL` (variable) | Worker **Settings → Variables and secrets** | Optional | Sends the daily usage heartbeat, unless statistics are off, to this https address instead of the project's collector at `https://kite-telemetry.midego.net/v1/heartbeat`, run by the Kite project on Cloudflare. An empty value sends nothing. |
| `URLHAUS_AUTH_KEY` (secret) | Worker **Settings → Variables and secrets** | Optional | A free abuse.ch Auth-Key. Kite then checks links, link hosts and attachment hashes of risky incoming mail against URLhaus and ThreatFox. `ABUSE_CH_AUTH_KEY` is accepted as another name; `URLHAUS_AUTH_KEY` wins when both are set. Instead of a secret, the owner can save the key under **Admin → General → Threat lookups**; a secret takes precedence. **Test key** there checks either. See [Spam protection](spam-protection.md#urlhaus-and-threatfox-lookups-optional). |

Generate random values with `openssl rand -hex 32`, or with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` if you do not have OpenSSL.

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

Copy-paste checklist for the token:

- [ ] Account API token (Manage Account → Account API Tokens), not a User API token or the Global API Key.
- [ ] Zone resources include every domain you will connect (or **All zones**).
- [ ] Zone permissions: **DNS: Edit**, **Zone: Read**, **Zone Settings: Edit**, **Email Routing Rules: Edit**.
- [ ] Account permission **Email Sending: Edit**, if Cloudflare will send mail.
- [ ] You copied the secret shown once at the end, not the token ID, and did not add `Bearer`.

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
   - `APP_ENCRYPTION_KEY`: another long random string (replace the example value). It encrypts provider keys and webhook secrets stored in D1. Keep a copy: changing or losing it makes those values unreadable. First-run setup in production refuses the example value and anything shorter than 16 characters; nothing is encrypted yet at that point, so it is safe to replace.
5. Start the deployment and wait for Cloudflare to finish.

Then, under the Worker's **Settings → Variables and secrets**, add `APP_URL` (variable): the app's public HTTPS address, for example `https://kite.<your-subdomain>.workers.dev`. Cloudflare shows the address when the deploy finishes, and the setup page in step 3 shows the exact value to copy. Password reset links, and receiving through Resend or SES, need it. It cannot be asked for at deploy time because the address does not exist yet.

If you installed before `APP_ENCRYPTION_KEY` was asked for at deploy time, add it as a secret under **Variables and secrets** yourself. Keys already stored as plain text keep working and are encrypted the next time they are saved.

## Step 3: Complete Kite setup

1. Open `/setup?setup_token=<your SETUP_TOKEN>` on the deployed Worker, or open `/setup` and enter the token when asked.
2. Let Kite check the configuration and initialize the empty D1 database. The first screen lists every check:
   - **Red** items stop setup until you fix them: missing or rejected `CF_TOKEN` (Kite asks Cloudflare for one zone to prove the token works), a missing D1 binding, or an `APP_ENCRYPTION_KEY` that is the example value or too short.
   - **Amber** items are recommended and do not stop setup: no `APP_ENCRYPTION_KEY`, no `APP_URL` (the message shows the value to use), an `APP_URL` that is not HTTPS or does not match the address you opened, a token that cannot see any zone, or a Worker that does not look like it is named `kite`.
   - After changing a variable or secret, redeploy if Cloudflare asks you to, reload the page and use **Check again**.
3. Create the first admin account.

Setup applies the committed migrations through the Worker's D1 binding before creating the first admin account.

## Step 4: Connect your primary domain and create a mailbox

1. Enter a domain that already uses Cloudflare DNS on the same account as your `CF_TOKEN`.
2. Continue while Kite enables Email Routing and configures the routing and sending DNS records.
3. Choose the address for your first mailbox and finish setup.
4. Open the inbox and send a test message to the new address.

If the domain's DNS is not ready yet (for example, it is not on Cloudflare yet), turn on **Skip DNS setup** in the domain step. Kite then records the domain without checking or changing any DNS and skips the MX check; mail does not arrive until the records are set. See [Skipping DNS setup](providers.md#skipping-dns-setup).

To connect more domains later, open **Admin → Domains**, select **New domain**, enter the hostname and choose the receiving service (or turn on **Skip DNS setup** to set the records up later). With Cloudflare, Kite configures Email Routing and Email Sending automatically. With Resend or Amazon SES, add the provider's credentials and run its setup from the domain page; see [Sending and receiving providers](providers.md). `CF_TOKEN` is still needed in every case, because Cloudflare manages the domain's DNS.

Resend and SES receive mail by calling your app, so set `APP_URL` to the app's public HTTPS address before setting them up for receiving.

## First 10 minutes: when something goes wrong

| What you see | Likely cause | Fix |
| --- | --- | --- |
| The Worker is not called `kite` (the setup page shows an amber "Worker name" warning on a `workers.dev` address) | The app name was changed in the deploy form | Deploy again with the name `kite` and delete the other Worker. |
| `/setup` says "Set a SETUP_TOKEN secret" or "SETUP_TOKEN is the example value" | The secret is missing, short or the example | Set a long random `SETUP_TOKEN` under **Variables and secrets**, redeploy, reload. |
| Red "Cloudflare API credentials" | `CF_TOKEN` was not set | Add it as a secret and redeploy. |
| Red "Cloudflare token works" with error 9109 or 10000 | Wrong value (token ID, `Bearer`, a User token) or missing permissions | Recreate the token with the checklist in step 1 and see [Troubleshooting](troubleshooting.md). |
| Red "Encryption key" | `APP_ENCRYPTION_KEY` is still the example value | Replace it with `openssl rand -hex 32` output. |
| Amber "Public address" | `APP_URL` is not set | Add the variable shown in the message. |
| The domain step cannot find your domain | The domain is not an active zone in the token's account, or the token's zone resources leave it out | Add the zone to Cloudflare and wait until it is active, then include it in the token's zone resources. |
| MX conflict | Another mail service already owns the domain's MX records | Confirm the replacement in the wizard, or keep the other service and do not connect that domain. |
| D1 error 7404 | `database_id` from another account | See [Troubleshooting](troubleshooting.md#d1-error-7404-database-could-not-be-found). |

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

Kite exports its D1 records as JSON and stores the backup files in the store routed for Backups under **Admin → Storage** (the `BUCKET` R2 binding by default). Existing backup files may remain in the previous or default store. These record exports do not include object contents. Turn on **Include mail files** to have each backup also copy raw mail, attachments and large message bodies next to it, with a manifest and a **Restore mail files** action ([full backups](operations.md#full-backups)); otherwise, and always for Drive files, separately back up every bucket holding mail or Drive objects, including old stores retained during migration (and the data directory's `blobs` folder for the default store on Node). New installs back up daily and keep 14 days of backups; existing installs keep their settings. A cron trigger in `wrangler.jsonc` runs daily at 02:00 UTC and applies the schedule selected under **Admin → Backups**. A manual backup queues the same record export on the `kite-outbound` queue and its consumer writes the file, so the admin request never waits for a large export. A backup left queued or running for more than 30 minutes is marked failed by the five-minute cron and by the Backups page itself. The admin overview shows the latest successful backup, its size and duration, and warns when the latest run failed.

Restore a backup from its row in the backup history, which reads the stored file by range, or upload a downloaded file with **Restore from backup**. Either way the backup is validated before anything changes, a safety backup of the current data is saved first, and the rows are written in batches, so a backup larger than Worker memory restores. See [Backups and restore](operations.md#backups-and-restore).

Deploy the complete Worker with `npm run deploy` whenever the cron trigger is added or changed.

## Object storage (optional)

By default every file Kite keeps (raw mail, attachments, Drive files, backups) is in the `BUCKET` R2 binding (`kite-raw`), and nothing below is needed. **Admin → Storage** (primary admin only) can add S3-compatible stores and choose, separately for Mail, Drive and Backups, which store new objects go to. It needs `APP_ENCRYPTION_KEY`: store keys are only ever saved encrypted, and the page refuses to add a store without it.

- **Direct Drive uploads to R2.** Without S3 API keys, Drive uploads pass through the Worker in 32 MiB parts. Select **Enable direct uploads** on the Default row and enter an R2 API token's S3 keys (R2 → Manage API tokens, **Object Read & Write** on `kite-raw`) and your account's endpoint, `https://<account id>.r2.cloudflarestorage.com`. Browsers then send 64 MiB parts straight to the bucket with signed URLs, and signed-in downloads of 8 MiB or more redirect to a five-minute signed link.
- **Another store.** **Add store** has presets for Amazon S3, Cloudflare R2 (S3 API), Backblaze B2, Wasabi, Hetzner, MinIO and any other S3-compatible service. Before saving, Kite checks the endpoint, the bucket, writing, reading and deleting a test object, a multipart upload and a signed link, and lists each failure with the permission or setting that fixes it. A wrong secret or a missing permission is reported by step.
- **CORS.** Drive can only be routed to a store whose CORS rule lets the Kite origin `PUT` parts and read their `ETag`. **Apply CORS** sets the rule on providers whose own keys may (S3, R2, Wasabi, MinIO); for the others the dialog shows the rule to add in the provider's console. Mail and backups do not need CORS.
- **Switching and migrating.** Switching a class sends new objects to the chosen store within 30 seconds; existing objects stay readable from the old one. Tick **Copy existing** to start a migration, which copies and verifies every object on the `kite-outbound` queue and shows its progress. Then choose **Finish and keep old copies** or **Delete from** the old store (behind a typed confirmation); a completed migration left alone finishes by itself after seven days and keeps the old copies. A migration that stops as failed after five consecutive batch failures needs **Retry** after the cause is fixed; it does not finish automatically. Providers may charge for the requests and for data leaving the old store.
- **Preview deployments** share the database, and therefore this setting, with production.

The Worker can only reach public `https` endpoints. Store changes, switches and deletions are written to the audit log.

## Email assistant and MCP

The assistant uses the Workers AI `AI` binding and a separate `kite-agent` queue. The Deploy to Cloudflare button creates the queue; for a manual deploy, create it before deploying. The five-minute cron recovers pending auto-draft work; the 02:00 UTC cron still runs backups.

In the inbox, open **Assistant → Settings** for a mailbox, select its reviewer, and enable the assistant. Auto-drafting is a separate opt-in. It skips spam, automated mail, and mailboxes with out-of-office replies enabled. Generated replies appear as ordinary drafts assigned to the reviewer. The reviewer must open the draft and confirm the exact content before delivery.

The assistant panel no longer exposes MCP key management. External MCP clients can still connect to `https://<your-kite-origin>/mcp` with a mailbox-scoped Bearer key created through the authenticated `/api/agent/mcp-keys` endpoint. Keys can be listed and revoked through that endpoint; a new key is shown only once. The server uses Streamable HTTP and accepts clients that can set a Bearer header. Its `request_send` tool returns a Kite review URL; the MCP key cannot confirm or deliver messages directly. MCP does not require Workers AI for read and draft tools.

## Updating Kite

Deploy a new version the same way you deployed the first one: push to the repository connected to Cloudflare's Git integration, or run `npm run deploy`. Kite does not check for or pull updates by itself.

Once the new version is live, everyone signed in with Kite open sees "Kite was updated. Reload to get the latest version." with a **Reload** button, the next time they return to the tab or within five minutes. The tab compares only the version its own server reports (`GET /api/version`, signed-in users only): the Worker's deployment id from the `CF_VERSION_METADATA` binding, or on the self-hosted runtime the build's version, commit and build time. Nothing outside your install is asked. When the server reports no version, the notice never appears. **Reload** sends the kite off first: the logo lifts off the page and flies up and to the right out of view while the page fades, and the new version loads right after (within about a second); a browser set to reduced motion reloads at once. While the new version loads, the loading screen shows the kite flying back in and floating on its string above the progress bar (standing still, with "Updating Kite…", under reduced motion); an ordinary reload keeps the plain loading screen.

A reload that lands while a deployment is still settling can get a page whose files answer 404 or stop arriving. Kite recovers from both before the app has started. A missing file reloads the page at once, at most four times within two minutes. When the loading screen has been up for 8 seconds of visible time and the app has not started, Kite reloads by itself: right away when nothing is loading any more, and otherwise only after 20 seconds without any file arriving (10 seconds once it has reloaded for this reason), so a slow load that keeps moving is never cut short (60 seconds at most). After two such reloads, or once the four are used up, it shows "Kite couldn't load" with a **Reload** button instead of its loading screen. When the sign-in check at start fails, it is tried three times; when it times out (6 seconds, then 4), twice. Then the page shows "Kite couldn't check your sign-in" with **Try again** and **Continue anyway**, and the check runs again when the user returns to the tab or comes back online.

Cloudflare's Speed Brain (in the dashboard under **Speed** → **Optimization** → **Content Optimization**) adds a `Speculation-Rules` header that lets browsers prefetch a page when a link is pressed. Kite does not need it: moving between its pages happens inside the app, so a prefetched page is rarely used, and every prefetch renders a whole page on the Worker. Turning it off for Kite's hostname is safe.

Deployment and database migration are separate. After Cloudflare deploys a new version, open or refresh the **Admin overview**. The database card, first on the page, lists every pending migration by file name and states that before applying them Kite saves a safety backup of the database when there is data to save (it is listed on the Backups page). Select **Update database** to apply them through the Worker's D1 binding. Only the primary admin can apply them; other admins see the same card with the number of waiting updates and the primary admin's name and address, so they know whom to ask. The same runner initializes a new database during setup.

While migrations are pending, everyone who opens the mailbox sees a banner: it names the number of waiting updates, warns that new email may not appear and that some pages may fail until they are applied, and tells them to ask an administrator; other admins are told the primary admin's name and address instead. The primary admin also gets **Apply now** there, which runs the same update as the database card (a safety backup first, then each migration in one D1 batch), and a link to the Admin overview. The check behind the banner reads only `d1_migrations`, so it works while the schema is behind; any signed-in user can call `GET /api/migrations/pending`, which answers `{ "pending": 1 }` and includes the migration file names only for the primary admin, and the primary admin (`appliedBy: { name, email }`) only for other admins.

Set `AUTO_APPLY_MIGRATIONS=1` (or `true`) to apply pending migrations without opening the Admin overview. Kite then applies them the first time it notices them, from the banner's status check or from the start of queue processing, with the same safety backup; it does each run once per Worker instance and never alongside another run in the same instance, and a failed run is retried by the next check. Two instances racing is safe: each migration is recorded in the same batch that applies it. The setting is an environment variable rather than a saved setting on purpose: a saved setting would live in the database whose schema is exactly what is out of date, so a column added for it could not be read until the migration that adds it had run. It is off by default, and it does nothing in the self-hosted Node runtime, which applies migrations at start-up.

A failed inbound or queued message is retried (Cloudflare Queues `max_retries: 3`) rather than dropped. When migrations are still pending at that moment, Kite waits 60 seconds instead of 10 before the next attempt, so applying them in that window still delivers the mail. Mail that has exhausted its three attempts is lost: the raw message stays in R2, but nothing re-enqueues it, which is the reason the banner is shown everywhere rather than only to admins.

If the Cloudflare dashboard has a custom deploy command containing `wrangler d1 migrations apply DB --remote`, remove that part and use `npm run deploy`.

Each migration and its `d1_migrations` history entry run in one D1 batch. If a migration fails, its changes are rolled back, the failed filename is shown, and it can be retried after the problem is corrected. Wrangler remains available as a manual recovery tool.

New application releases must remain compatible with the previous schema until an administrator applies their migrations. Prefer additive changes, keep old columns during the transition, and avoid making authentication or the admin settings page depend immediately on a newly added column. Plan a maintenance window for an incompatible schema change.

When adding a schema change, create a new uniquely named SQL file in `drizzle/migrations` and do not edit an applied migration. Build and development commands generate the Worker migration bundle from those files. `npm run db:bundle` can generate it explicitly.

## Try a branch before it goes live

A [Worker Preview](https://developers.cloudflare.com/workers/previews/) runs a branch's code on its own address, such as `<branch>-kite.<subdomain>.workers.dev`, while production keeps running `main`. The `previews` block in `wrangler.jsonc` points Previews at the production database, R2 bucket and queues, so you sign in with your usual account and see your real domains, mailboxes and mail.

One-time setup in the Cloudflare dashboard, under **Workers & Pages → kite → Settings**:

1. **Builds**: in the **Set up Worker Previews** banner, select **Set up** and then **Switch to Worker Previews**. This cannot be undone. Under **Branch control**, keep **Enable Preview Builds** on, and make sure the build command is `npm run build` so the Preview command finds the built Worker.
2. **Variables and secrets**: choose **Previews Base** and import the variables from production. Secrets are not copied, so add them again with the same values. `APP_ENCRYPTION_KEY` must match production exactly, or the Preview cannot read stored provider keys. Add `CF_TOKEN`, and `TURNSTILE_SECRET_KEY`, `AI_API_KEY` or `URLHAUS_AUTH_KEY` if production has them.

After that, every push to a branch other than `main` builds a Preview, and the Preview URL appears under the Worker's deployments. You can also run `npx wrangler preview` from a branch on your own machine.

A Preview works on production data, so treat it as production:

- Mail you send, delete or move there really is sent, deleted or moved. Work the Preview queues, such as scheduled sends, imports and webhook retries, runs on the production Worker.
- Never select **Update database** in a Preview. A branch with new migrations would apply them to the production database. Test those with a copy of the database instead.
- Incoming mail, cron jobs and queue processing stay on production. The Preview has its own realtime connection, so new mail appears after a refresh rather than live.
- The Preview URL is public, behind the normal Kite sign-in. Protect it with [Cloudflare Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/) if you want a second gate. If production uses Turnstile, add the `workers.dev` hostname to the widget's allowed hostnames. If `APP_URL` is set for Previews, MCP clients can only connect to that address.
