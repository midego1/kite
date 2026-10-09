# Moving to the Kite resources

Earlier releases ran as the Worker `mailflare`, with the D1 database `mailflare`, the R2 bucket `mailflare-raw` and the queues `mailflare-inbound`, `mailflare-outbound` and `mailflare-agent`. This release uses `kite`, `kite-raw` and `kite-*`. Cloudflare cannot rename a Worker, database, bucket or queue, so an existing install moves once:

1. A new `kite` Worker with its own resources is set up beside the old one.
2. It copies the old database and bucket through two extra bindings, `LEGACY_DB` and `LEGACY_BUCKET`.
3. It takes over Email Routing and the custom domain.
4. The old Worker is retired.

The old install keeps working until step 3, so there is no rush, and you can return to it until you delete it.

## What is copied

- Every table in the backup list (accounts, sessions, mailboxes, messages, contacts, rules, settings, API keys, webhooks, backup history and the rest), and every object in the old bucket: raw mail, attachments, avatars, the branding icon and backup files.
- Not copied: Worker secrets and variables (set them again), Analytics Engine history, logs and anything still waiting in the old queues.
- Provider keys stored encrypted (Resend, AWS, alert webhook secrets) can be read only with the same `APP_ENCRYPTION_KEY`. If the new Worker has a different key, or none, the copy report lists those settings so you can enter them again. Without `APP_ENCRYPTION_KEY` on the old Worker nothing was encrypted and everything carries over.

## Before you start

- In the old install, open **Admin settings** and apply any pending database updates, so both databases have the same tables.
- Let scheduled and undo-send mail go out, and avoid scheduling new sends until the move is done. A send held in the old queue is sent by the old Worker.
- Make a manual backup under **Admin → Backups** in the old install.

## 1. Create the resources

In the Cloudflare account of the old install, create:

- D1 database `kite`
- R2 bucket `kite-raw`
- Queues `kite-inbound`, `kite-outbound` and `kite-agent`

Put the new database id into `wrangler.jsonc`, as `database_id` of the `DB` binding in both the top-level `d1_databases` and the `previews` block. The old database and bucket are bound as `LEGACY_DB` and `LEGACY_BUCKET`. If your `wrangler.jsonc` does not have them, add them to the top-level lists, with the id of the old database:

```jsonc
"d1_databases": [
	// the DB binding, then:
	{ "binding": "LEGACY_DB", "database_name": "mailflare", "database_id": "<old database id>" },
],
"r2_buckets": [
	// the BUCKET binding, then:
	{ "binding": "LEGACY_BUCKET", "bucket_name": "mailflare-raw" },
],
```

## 2. Create the Worker

Under **Workers & Pages → Create → Import a repository**, pick the Kite repository (or your copy of it) and name the Worker exactly `kite`, with `main` as the production branch. If the Cloudflare GitHub app may only see selected repositories, give it access to that repository first. Set the build command to `npm run build` and keep the deploy command `npx wrangler deploy`.

Add the secrets and variables the old Worker has: `CF_TOKEN`, `SETUP_TOKEN` (any long random string), `APP_URL` (the public address, such as `https://mail.example.com`), and if the old Worker has them `APP_ENCRYPTION_KEY` (the same value), `TURNSTILE_SECRET_KEY` and `AI_API_KEY`.

## 3. Copy the data

1. Open the new Worker's `workers.dev` address and go to `/setup?setup_token=<SETUP_TOKEN>`. Create a temporary admin account; any address and password will do, because the copy replaces it.
2. Do not add a domain. Open `/admin` instead.
3. In the **Database** card, apply the database updates if any are listed.
4. In **Move from the old install**, select **Copy everything** and type `replace`. Keep the page open until the copy is done. If it stops, select **Continue**, or start it again: rows and files already copied are skipped.
5. The temporary account is gone afterwards. Sign in with your usual account and check the inbox, a few attachments and the settings. Enter any settings the report lists again.

## 4. Take over the mail

1. In the same card, under **Mail routing**, select **Check Email Routing**, then **Move to kite**. Email Routing now delivers new mail to the new Worker.
2. Select **Copy new mail**. It adds the mail and files that reached the old install since the full copy and leaves everything else as it is.
3. Move the custom domain: on the old Worker, under **Settings → Domains & Routes**, remove the domain; on the new Worker, add it as a custom domain. The address is unavailable for a minute or two.
4. Open the usual address. Sessions were copied, so browsers that were signed in stay signed in, and preferences stored in the browser carry over.

## 5. Retire the old install

1. Disconnect the old Worker from Git (**Settings → Build**), so it never builds the renamed configuration. If it builds the same repository as the new Worker, do this before the change reaches the branch it builds.
2. Remove the `LEGACY_DB` and `LEGACY_BUCKET` bindings from `wrangler.jsonc` once you no longer need to copy anything. The card disappears with them. Do this before anyone else installs from the repository: the Deploy to Cloudflare button deploys `main`, and a new install must not get bindings for a database it does not have.
3. Keep the old Worker, database and bucket until you are sure, for example a week, and until the new install has made its own backup. Then delete the Worker `mailflare`, the database `mailflare`, the bucket `mailflare-raw` and the three `mailflare-*` queues.

## Self-hosted (Docker)

Nothing to move by hand. On the first start, the server renames `mailflare.sqlite` to `kite.sqlite` in the data directory, with its WAL files, and keeps queued jobs. The Compose service is now called `kite`, so start it with `docker compose up -d --build --remove-orphans` to replace the old `mailflare` container. The volume keeps its name, `mailflare-data`.

The relay in `deploy/cloudflare-email-relay` is now `kite-email-relay` and reads `KITE_URL`. A relay deployed under the old name keeps working: the server accepts its headers, and it reads `MAILFLARE_URL` when `KITE_URL` is not set. Update the server first.
