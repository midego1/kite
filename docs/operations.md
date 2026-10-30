# Operations and review ownership

Repository review owner: `@midego1` (see `.github/CODEOWNERS`). Production
operators must be identified by the deployment owner; no on-call rota, paging
integration, dashboard or alert destination is configured by these changes.

## Verification surfaces

- PR validation: application/relay checks, build, local relay integration and
  Chromium suite in the "Mission validation" job, and `npm run build:node` in the
  parallel "Node build" job of `.github/workflows/ci.yml`. Verify the exact job
  name before making it a required check.
- Advisory: `.github/workflows/pr-report.yml` summarizes security, quality,
  coverage and repository rules on each pull request. It is not a required check.
- Documentation: `.github/workflows/docs.yml` validates generated route inventory
  and documented command/link contracts.
- Security: `.github/workflows/security.yml` runs redacted Gitleaks history checks
  and repository-owned Semgrep source rules. Scheduled runs require the workflow
  on the default branch and GitHub Actions to be enabled.
- Runtime: structured logs are available at their deployment's existing log
  destination. Worker/Node request wrappers emit JSON status/duration events
  for server errors, client errors and slow requests (over 1000 ms), not for
  fast successful ones, and propagate W3C `traceparent`; relay receive logs include correlation and
  duration metadata, and relay callbacks pass `traceparent` to the app. There
  is no external trace collector configured. Workers Builds status belongs to the existing Cloudflare Git
  integration. No new remote data collection is installed here.

`GET /api/setup/status` is the existing availability probe. A 200 indicates the
setup/database reads completed; inspect the JSON for setup state. It includes
domain metadata, so do not attach the response publicly. It does not verify
email delivery, queues, R2, providers or backup freshness.
The relay exposes `GET /health` as a liveness check only; it does not contact
the upstream app or validate provider credentials. Relay callbacks time out
after 15 seconds. Use synthetic delivery
and a verified backup record for those checks.

## Metrics

The Worker and the relay write data points to the Workers Analytics Engine dataset `kite_metrics` (binding `METRICS`; the dataset is created on the first write). The Node runtime uses a no-op. Labels hold categories only: route templates, HTTP method, status class, queue name, message kind, provider and outcome. Addresses, ids, URLs, paths and error text are never recorded. Any label that is not a short `[A-Za-z0-9_.:/[]{}-]` string without `@` is stored as `other`.

Fixed layout (`src/lib/metrics.mjs`):

- `index1`: event (`http`, `queue`, `send`, `webhook`, `relay`, `inbound`).
- `blob1..blob7`: event, service (`kite`, `kite-email-relay`, `node`), name, outcome, status class, detail, version (the Worker version id, from `CF_VERSION_METADATA`).
- `double1..double4`: duration in ms, status, attempts, and `1`.

Route templates come from `src/lib/metrics-routes.generated.json`, written by `node scripts/docs-generate.mjs` and checked by `npm run docs:check`.

Example, 5xx rate and p95 per route over the last hour, run against `https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/analytics_engine/sql` with a token that has Account Analytics Read:

```sql
SELECT blob3 AS route, SUM(_sample_interval) AS requests,
  SUM(IF(blob5 = '5xx', _sample_interval, 0)) AS errors,
  quantileWeighted(0.95, double1, _sample_interval) AS p95_ms
FROM kite_metrics WHERE index1 = 'http' AND timestamp > NOW() - INTERVAL '1' HOUR
GROUP BY route ORDER BY requests DESC LIMIT 25
```

## After a deploy

A push to `main` deploys the main Worker through the Cloudflare Git integration. The email relay is deployed separately by hand. Work through the section for each Worker you changed, then compare before and after.

### Main Worker (kite)

1. In GitHub, open the commit's checks and confirm `Workers Builds: kite` (app `cloudflare-workers-and-pages`) passed. `.github/workflows/deploy-record.yml` then records a GitHub deployment; the repository's **Deployments → production** entry carries the commit and the Worker version. `.github/workflows/release-publish.yml` tags the commit `v<VERSION>` and publishes its GitHub release; a warning on that run means the merge did not bump `VERSION` ([Releasing](releasing.md#after-the-merge)).
2. In the Cloudflare dashboard open Workers & Pages → `kite` → Deployments and note the new version id. Keep the previous id for the comparison below.
3. Open Logs (Observability) and search for these JSON events:
   - `http.request_completed`: 5xx responses, 4xx responses and slow requests (over 1000 ms).
   - `http.request_failed`: an exception escaped a route.
   - `queue.processing_failed`: a queue message failed and will be retried.
   - `inbound.enqueue_failed`: the email handler could not store or enqueue inbound mail.
   - `backup.scheduled_failed`: the scheduled backup failed.
   - `backup.stale_marked_failed`: a queued or running backup was interrupted and was marked failed.
   - `alerts.*`: the operational alert run (see [Operational alerts](#operational-alerts)).
4. Open Metrics and compare requests, errors and CPU time with the period before the deploy.
5. On the Admin overview, the database card (`src/components/admin-update-card.tsx`, `GET /api/admin/migrations`) shows pending D1 migrations. Apply them from there; deploys never migrate for you. Until they are applied, the mailbox shows the same warning with an **Apply now** button (`GET /api/migrations/pending`), and inbound mail is retried rather than stored. With `AUTO_APPLY_MIGRATIONS=1` the first check or queue batch applies them instead, after saving the usual safety backup.
6. `GET /api/setup/status` answers 200 when the setup and database reads work. It does not prove queues, R2 or providers.
7. Send a synthetic message from a mailbox and receive one from outside. Both must arrive. Use only `example.com` style synthetic addresses.

### Email relay (kite-email-relay)

The relay is deployed manually by the self-hosting operator. It has no Workers Builds check.

1. Dashboard → Workers & Pages → `kite-email-relay` → Deployments, and note the version id.
2. In Observability look for `relay.request_failed` (the app call failed, so the message is rejected or retried) and `relay.forward_failed` (a forward decision could not be carried out). `relay.request_completed` is the success event.
3. `GET /health` on the relay is a liveness check only. It does not contact the app.
4. Analytics Engine rows for the relay have `blob2 = 'kite-email-relay'`. The outcomes are `reject`, `store`, `forward`, `forward_failed`, `too_large`, `upstream_too_large` and `upstream_error`.
5. The relay has no email alerts. Watch its logs and metrics yourself.

### Analytics Engine queries

Query the dataset `kite_metrics` through the SQL API. The layout is in [Metrics](#metrics): `index1` is the event, `blob1..blob7` are event, service, name, outcome, status class, detail and version, and `double1..double4` are duration in ms, status, attempts and `1`.

```sh
curl "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/analytics_engine/sql" \
  -H "Authorization: Bearer $TOKEN" \
  --data "SELECT blob7 AS version, SUM(_sample_interval) AS requests FROM kite_metrics WHERE index1 = 'http' AND timestamp > NOW() - INTERVAL '1' HOUR GROUP BY version"
```

The token needs Account → Account Analytics → Read. Never paste the token into issues, pull requests or chat.

Useful queries (replace the `--data` text):

```sql
-- Queue retries and acks by queue and message kind
SELECT blob6 AS queue, blob3 AS kind, blob4 AS outcome, SUM(_sample_interval) AS messages
FROM kite_metrics WHERE index1 = 'queue' AND timestamp > NOW() - INTERVAL '1' HOUR
GROUP BY queue, kind, outcome ORDER BY messages DESC

-- Send failures by provider
SELECT blob3 AS provider, blob4 AS outcome, SUM(_sample_interval) AS sends
FROM kite_metrics WHERE index1 = 'send' AND timestamp > NOW() - INTERVAL '1' HOUR
GROUP BY provider, outcome

-- Webhook deliveries by outcome (delivered, retrying, exhausted)
SELECT blob4 AS outcome, SUM(_sample_interval) AS deliveries
FROM kite_metrics WHERE index1 = 'webhook' AND timestamp > NOW() - INTERVAL '1' HOUR
GROUP BY outcome

-- Relay decisions and failures
SELECT blob4 AS outcome, SUM(_sample_interval) AS messages
FROM kite_metrics WHERE index1 = 'relay' AND blob2 = 'kite-email-relay' AND timestamp > NOW() - INTERVAL '1' HOUR
GROUP BY outcome
```

### Compare before and after

1. Note the old and the new version ids.
2. Query equal windows, for example 30 minutes before and 30 minutes after the deploy, grouped by `blob7` (the version). `blob7` is empty when `CF_VERSION_METADATA` is not bound; then group by time window instead.
3. Compare the 5xx rate, p95 duration per route, the queue retry rate, send failures by provider, exhausted webhook deliveries and relay `upstream_error` counts.
4. Consider a rollback when the 5xx rate is more than twice the old rate and above 1%, or when sends or relay forwarding fail persistently. Follow [backup and deployment recovery](runbooks/recovery.md). The operator performs any rollback.

### Operational alerts

A cron trigger (`*/5 * * * *`) runs the alert check in the Worker; Node/Docker runs it on the same 5-minute schedule (`server/runtime/scheduler.ts`). The code lives in `src/lib/alerts/`. The rules:

| Rule                | Fires when                                                          |
| ------------------- | ------------------------------------------------------------------- |
| Failed sends        | 5 or more outbound jobs failed in the last 60 minutes               |
| Stuck outbound jobs | any job has been queued for over 30 minutes or sending for over 15 |
| Exhausted webhooks  | any webhook delivery ran out of retries in the last 60 minutes      |
| Failed backups      | any backup failed in the last 60 minutes                            |
| Email relay header signature | the email relay sent a request without a header signature, or with a wrong one, in the last 60 minutes: its mail arrives, but sender authentication counts as unknown until the relay is updated (or `INBOUND_WEBHOOK_SECRET` matches) |
| Database nearly full | the database is above 90% of its size limit (see [Database size](#database-size)); never fires on Node, where there is no limit |
| Email relay older signature (low priority) | the email relay still signs with the older header signature form, accepted until the first release on or after 2027-01-31 ([#118](https://github.com/midego1/kite/issues/118)); update the relay |

Behaviour:

- The first run records a baseline in `system/alert-state.json` (an object in the R2 bucket) and sends nothing. Rules that count events (failed sends, exhausted webhooks, failed backups) look back 60 minutes but never earlier than the baseline, so older events never alert. Stuck outbound jobs are not filtered by the baseline: a job that was already stuck at the first run is still stuck on the second run, and alerts then (subject to the hourly email limit).
- At most one notification is sent per hour, and one notification combines all new alerts.
- An unchanged problem is repeated after 24 hours. A problem that clears and returns alerts again.
- Set `OPERATIONAL_ALERTS=off` to turn the check off. This also stops the webhook and hides the banner.

#### Channels

| Channel        | Destination                                                                    | Configured in                         |
| -------------- | ------------------------------------------------------------------------------ | ------------------------------------- |
| Email          | The primary admin's recovery address (`reset_email`), or else its login email | Settings → Account (recovery email)   |
| Webhook        | One URL: Slack, Discord, ntfy or any endpoint that accepts JSON                | Admin → Alerts (primary admin only)   |
| Admin banner   | Every admin's dashboard, while a rule is active                                | Always on; nothing to configure       |

The webhook is optional. It is one setting for the whole deployment, stored in `app_settings` (migration `drizzle/migrations/0059_add_alert_webhook.sql`). The URL is encrypted with `APP_ENCRYPTION_KEY` when that key is set, like other provider secrets. Admin → Alerts never shows the saved URL again, only its host (for example `Saved: hooks.slack.com/…`), because the URL is the credential.

#### Set up a webhook

Open Admin → Alerts as the primary admin, paste the URL, leave **Format** on **Auto-detect** or pick one, and press **Save**. Auto-detect picks Slack for `hooks.slack.com`, Discord for `discord.com` or `discordapp.com` (including `ptb.` and `canary.`) with a path starting `/api/webhooks/`, ntfy for `ntfy.sh`, and Generic JSON for anything else. A Format other than Auto-detect always wins. **Remove** deletes the URL and the format.

The URL must use `https`, must not contain a user name or password, and must not point at a private, loopback, link-local or internal address (on Node the host name is also resolved and checked). Saving rejects such a URL, and every send checks it again.

- **Slack:** create an app with Incoming Webhooks (or use an existing one), add a webhook to the channel, and copy its URL, for example `https://hooks.slack.com/services/EXAMPLE/EXAMPLE/EXAMPLE`.
- **Discord:** Server settings → Integrations → Webhooks → New Webhook, choose the channel, then Copy Webhook URL, for example `https://discord.com/api/webhooks/000000/EXAMPLE`.
- **ntfy.sh:** pick a hard-to-guess topic name and use `https://ntfy.sh/<topic>`, for example `https://ntfy.sh/example-topic`. Subscribe to the same topic in the ntfy app. Anyone who knows a public topic name can read it.
- **Self-hosted ntfy:** use `https://<your-ntfy-host>/<topic>` and set Format to **ntfy**, since auto-detect only recognises `ntfy.sh` and would otherwise send Generic JSON. Kite sends no `Authorization` header, so allow anonymous publishing to that topic (or put an access token in the URL in a form your ntfy server accepts).
- **Generic JSON:** any HTTPS endpoint that accepts a `POST` with a JSON body, for example `https://alerts.example.com/hook`. Use this for your own automation or a paging service's generic webhook.

#### Payloads

Every request is a `POST` with `redirect: manual`. A 2xx answer is a success; anything else, including a redirect, is a failure. The response body is never read. With `APP_URL` set, each alert line is followed by a link to the page to check; without it, the links are left out and `url` is `null`.

Slack (`content-type: application/json`):

```json
{
	"text": "Kite: 2 operational alerts\n\n- Failed backups: 1\n  https://mail.example.com/backups\n- Outbound messages stuck in the queue: 2\n  https://mail.example.com/admin"
}
```

Discord (`content-type: application/json`; `content` is cut to 2000 characters):

```json
{
	"content": "Kite: 2 operational alerts\n\n- Failed backups: 1\n  https://mail.example.com/backups\n- Outbound messages stuck in the queue: 2\n  https://mail.example.com/admin"
}
```

ntfy (plain text; the subject goes in the `Title` header):

```http
Content-Type: text/plain; charset=utf-8
Title: Kite: 2 operational alerts
Priority: high
Tags: warning

- Failed backups: 1
  https://mail.example.com/backups
- Outbound messages stuck in the queue: 2
  https://mail.example.com/admin
```

Generic JSON (`content-type: application/json`):

```json
{
	"app": "Kite",
	"alerts": [
		{ "rule": "backup_failed", "name": "Failed backups", "count": 1 },
		{ "rule": "outbound_stuck", "name": "Outbound messages stuck in the queue", "count": 2 }
	],
	"url": "https://mail.example.com",
	"sentAt": "2026-10-08T09:15:00.000Z"
}
```

The `rule` values are `backup_failed`, `outbound_failed`, `outbound_stuck`, `webhook_exhausted`, `relay_signature` and `relay_signature_legacy`. Only a test send adds `"test": true`.

#### Send test alert

**Send test alert** on Admin → Alerts (`POST /api/admin/alerts/webhook/test`) posts one test message to the saved URL in its effective format, once, with a 10-second timeout and no retry. It never sends email and does not touch the alert state. The page reports success, or the reason (timeout, network error, HTTP status, blocked URL, unreadable setting) and the HTTP status when there is one. The test message is one alert named `Test alert` with the subject `Kite: test alert`; ntfy gets `Priority: default` and `Tags: white_check_mark`, and Generic JSON looks like this:

```json
{
	"app": "Kite",
	"alerts": [{ "rule": "test", "name": "Test alert", "count": 1 }],
	"url": null,
	"sentAt": "2026-10-08T03:21:14.108Z",
	"test": true
}
```

#### Delivery

- Email and webhook are tried independently and at the same time; a failure in one never stops the other.
- Each channel gets a timeout per attempt (15 seconds for email, 10 seconds for the webhook) and one retry about a second later. A blocked or unreadable webhook URL is not retried.
- An alert counts as delivered when at least one channel succeeds. So when email fails (for example no domain can send, or the provider is down) but the webhook works, the alert still arrives by webhook, and the hourly limit and 24-hour reminder apply as usual. The log shows `alerts.channel_failed` for the email and `alerts.notified` with `channels: ["webhook"]`.
- When every channel that was tried fails, nothing is marked as sent and the next attempt waits one hour (`alerts.notify_failed`).
- When no channel is available (no sending domain and no webhook), the run logs `alerts.notify_skipped` and tries again on the next run.
- The throttle and reminder rules are the same as before the webhook existed; they count a notification on any channel.
- If `APP_ENCRYPTION_KEY` changes and the saved URL can no longer be decrypted, Admin → Alerts still shows a webhook as configured, the webhook channel fails with `alerts.webhook_unreadable`, and you need to save the URL again.

#### Privacy

Emails and webhook payloads contain only the app name, rule ids, rule names, counts, links to Kite pages and the send time. They never contain addresses, message or job ids, fingerprints or error text. Logs record the channel, attempt, reason and HTTP status, never the webhook URL or host, the recipient or the receiver's response.

#### ALERT_WEBHOOK_ALLOW_INSECURE (dev and test only)

`ALERT_WEBHOOK_ALLOW_INSECURE=1` (or `true`) lets the webhook use `http` to a loopback address (`localhost`, `127.0.0.0/8`, `[::1]`) so a local receiver can be used in development and the Playwright suite. It allows nothing else: other private addresses stay blocked and other hosts still need `https`. It is refused in production: the check ignores the flag whenever `NODE_ENV` is `production`, which is always the case in a built Worker and in the Docker image, and `vite.config.ts` passes it to the Worker only for `vite dev`, so it never reaches a build. Never set it on a deployment.

#### Admin banner

While any rule is active, every admin sees a compact notice in the sidebar, above Settings (over the page on phones and while the sidebar is collapsed), listing each alert with its count and a link to the page to check. It reads `GET /api/admin/alerts/active`, which only evaluates the rules: it sends nothing and writes no state. The banner loads when the page opens and refreshes every 5 minutes; users who are not admins never request it. **Dismiss** hides it in that browser until the set of active alerts changes (a new rule fires, or a rule clears and returns); a count changing alone does not bring it back. Dismissal is stored in the browser under `kite-dismissed-alerts`.

#### Blind spots

Email alerts need working outbound sending, and webhook alerts need the receiver to be reachable. Configure the webhook so a sending outage still reaches you. If both fail, check the logs for `alerts.notify_failed` and `alerts.channel_failed`.

### Database size

D1 holds the whole mailbox, and a database has a hard size limit: 10 GB on Workers Paid, 500 MB on Workers Free. Kite reads the current size from the `size_after` field that every D1 result carries (`getDatabaseSize` in `src/lib/db/size.ts`; on Node the SQLite wrapper fills the same field from `page_count * page_size`, and there is no limit).

- **Limit.** The default is 10 GB. On Workers Free set the variable `D1_MAX_BYTES=500000000` so the warnings use the right limit. Values are decimal bytes, as Cloudflare states the limits.
- **Admin → Overview** shows the size against the limit for the primary admin: amber from 70%, red from 90%. The operational alert "Database nearly full" fires at 90% (see [Operational alerts](#operational-alerts)).
- **Imports.** Settings → Import estimates what a limited import adds (messages × the install's average D1 bytes per message, 40 KB until it holds 1,000 messages, at most 128 KB per message) and warns from 70% of the limit. Above 90%, now or after the import, **Start** needs **Import anyway**, and the server refuses the request with 409 `DATABASE_NEARLY_FULL` without `confirmDatabaseFull`. Whole-folder imports do not know their size before they start, so only the current size counts. Whole-account imports add up the per-folder message counts the plan reported; the browser sends those back, so they are advisory, and a single unknown count leaves only the current size to check. The running import's own size check below applies either way.
- **Running imports pause themselves.** After every batch an import checks the size. At 90% it sets itself to **Paused** (keeping its saved source password and cursor), shows why, and the primary admin gets the operational alert. **Resume** asks for confirmation while the database is still above 90%; a confirmed import stops again at 98%, so the database never fills completely, and from 98% neither Resume nor a new import is accepted (409 `DATABASE_FULL`) until space is freed. A job paused for more than 7 days is cancelled and its saved password erased.
- **What to do.** Delete mail and empty Trash and Spam, take and download a backup first ([backups](#recovery-and-data-handling)), or move to a plan with a larger limit. Deleting rows frees space for new rows, but D1 may report the old size until it compacts.
- **Large imported bodies.** Imported HTML bodies over 16 KB (`BODY_OFFLOAD_BYTES`) are written to the Mail store at `bodies/<message id>.html` and the row records the key in `messages.html_body_key` (migration 0074), with `html_body` null and the text body kept for search; every reader goes through `loadMessageBodies` (`src/lib/email/bodies.ts`). Deleting a message deletes its body object, and switching the Mail store under Admin → Storage moves the bodies with raw mail and attachments (and **Delete old copies** removes them). If a body cannot be read when a mailbox is exported, the export fails with "Some messages could not be read from mail storage" (503 `BODY_UNAVAILABLE`) instead of writing that message as text; try again. A database backup carries `html_body_key` and `body_size` but not the object, like raw MIME and attachments: back up the Mail store too, or turn on [full backups](#full-backups), which copy the bodies with the raw mail and attachments. A restore without the objects shows those messages as their text body.
- **Tests only.** With `DATABASE_SIZE_TEST_HEADER=1` (set by the dev and e2e server only, never in a deployment) and outside production, the header `X-Kite-Test-Database-Size: used=<bytes>;limit=<bytes>` makes the admin size, the import estimate and the import start and resume checks use that size (`e2e/60-database-size.spec.ts`). Without the flag, or when `NODE_ENV` is `production`, the header does nothing.

### Full backups

**Include mail files** under [Admin → Backups](/backups) (off by default; `backup_settings.include_objects`, migration 0081) makes every backup, manual or scheduled, also copy the objects the mail lives on: raw MIME (`messages.raw_r2_key`), attachments (`message_attachments.r2_key`) and offloaded HTML bodies (`bodies/<message id>.html`). Drive files are not included.

- **Where.** The copies go to `backups/objects/<YYYY-MM-DD>-<backup id>/files/<original key>` in the store routed for Backups, read from wherever the Mail class reads (active, previous, then default store, through `getStorage`). Each batch writes a manifest part `manifest/<n>.json` (`{ objects: [{ key, size }], missing: [key], failed: [key] }`), and the end writes `manifest.json` (`format: "kite-backup-objects"`, the database backup's key, counts and bytes).
- **How.** A backup that starts with the setting on is marked `pending` before its export. The database export finishes first and the backup is usable at once; a copy that cannot even start (a queue or D1 error) marks only the copy failed, never the database backup, and a `pending` backup whose runner died before starting the copy gets it from the five-minute check two minutes after its export finished, so a full backup never silently stays database-only. The copy then runs on the outbound queue (`backup.objects.copy`, `src/lib/backups/objects.ts`), at most 20 objects or 128 MB per message, which keeps a consumer batch of five messages well under the 1,000 subrequests an invocation may make. Its position, totals, step number and lease live in `backups.objects_cursor`: a message names the step it is for, so a duplicate or late message is dropped, and a delivery that finds the step leased by another is queued again for after the lease (10 minutes) instead of running beside it. An object already copied with the same size is not copied again, and raw mail is walked by key, so a raw object several messages share (copies in other mailboxes) is copied and counted once. `backups.objects_status` is `copying`, then `completed` or `failed`; objects the database names but no store holds count as missing, and objects that cannot be read or written count as failed (`objects_failed`) while the rest of the batch goes on. A copy whose heartbeat (`objects_updated_at`) is older than 30 minutes is marked failed by the five-minute cron and the Backups page, with "Copying the mail files was interrupted before it finished".
- **Retry.** The retry button on a backup whose copy failed, or finished with files it could not copy (`POST /api/backups/[id]/objects/retry`), copies again: a failed copy resumes where it stopped, a finished one starts over and only checks the files it already has; a copy that failed before it started gets the folder it would have had.
- **Settings in a restored database.** A restore replaces `backup_settings` with the backup's row. A backup taken before migration 0081 has no `include_objects`, so restoring it turns **Include mail files** off; turn it on again afterwards.
- **Size.** Every full backup holds its own copy; nothing is shared between backups, so daily backups kept 14 days hold about 14 copies, and the setting says so with the total. The page estimates the size per backup only when asked (**Estimate the size**) or while the switch is on (`GET /api/backups/objects`), from counts, the attachment sizes and the bodies of the latest 500 messages as a sample: the raw mail as its bodies plus the attachments base64-encoded plus 2 KB of headers per message, plus the attachments and offloaded bodies themselves. A finished full backup shows what it actually copied.
- **Restore.** **Restore mail files** on a full backup (`POST /api/backups/[id]/objects`, 409 while its files are being copied or restored) copies every object of its manifest back to its own key, but only where nothing exists under that key now, so it never overwrites live mail; it runs on the queue (`backup.objects.restore`, one manifest part per message, with the same steps and lease) and the row shows **Restoring mail files** until it is done. The result (restored, already there, failed) is kept in `backups.objects_restore` and shown on the row, in red when anything failed or the restore was interrupted. To recover a backup as a whole, restore the database first and then its mail files: restoring a full backup from its row writes its `objects_*` columns back with it, so it still lists its files and **Restore mail files** afterwards. A backup whose files are being copied or restored at that moment cannot be restored (409) until that finishes. Manifest entries that are not a relative Mail key (an empty, `.` or `..` segment, a leading `/`, another class) are skipped and counted as failed.
- **Deleting.** Deleting a full backup, by hand or by retention, queues the removal of its copies (`backup.objects.delete`, 1,000 objects per store per message) from every store the Backups class may hold them in: the active one, the previous one while a move is pending, and the default. A backup whose files are still being copied or restored is neither deleted nor expired.
- **Orphaned copies.** Restoring a database replaces the `backups` table, so full backups newer than the restored data lose their rows while their files, like their database backup files, stay in storage. Retention never sees them; remove the `backups/objects/<date>-<id>/` folders of backups no longer listed by hand from the bucket. Copies left on a store the Backups class no longer reads (after a move finished) are orphaned the same way.

### Retention for new installs

A new install (migration 0081 applied while it has no account yet, which setup and the Node runtime always do) starts with daily automatic backups that are deleted after 14 days. Existing installs keep their settings. **Delete old backups automatically** is shown on the Backups page even while automatic backups are off, since it also removes manual and safety backups.

### Backups and restore

- **Backup health.** Admin → Overview shows the primary admin the latest successful backup (any kind, including the automatic ones before a restore or a database update) with its size and how long it took, whether automatic backups are on and how long they are kept, and a red warning with the error when the latest finished run failed (`GET /api/backups/health`, `getBackupHealth` in `src/lib/backups/service.ts`). A later successful run clears the warning. Like the Backups page, the check first marks runs interrupted for over 30 minutes as failed. The operational alert "Failed backups" still covers the hour after a failure (see [Operational alerts](#operational-alerts)). The card also shows the latest restore while it runs and for a day after it ends; a restore that could not be rolled back stays there, with a **Restore previous data** button (`POST /api/backups/restore/recover`), until it is resolved.
- **Restoring.** A restore never needs the whole backup in memory. It reads the file by byte range in 2 MiB pages (`BACKUP_PAGE_SIZE`, `src/lib/backups/backup-reader-utils.ts`) twice: the first pass checks every row as it would be inserted (a column the table has, at most 100 of them, no object or array values) and records where each table's rows are, without writing anything; the second empties the tables and inserts each table's rows, parents first, in multi-row statements of at most 100 bound parameters, sent to D1 in batches of at most 500 statements or 4 MB (`RestoreBatchWriter`). Each batch is one transaction. The DELETEs go first in batches of their own, and the kept backup rows get theirs. When any batch fails, the database is restored from the safety backup taken just before, read back by range in the same way and with the same storage tables left alone: even a batch that answered with an error may have been committed. Only a failure before the first batch was sent (the file can no longer be read, say) changes nothing. Pre-0019 backups fill messages from their `message_bodies` rows with updates after the messages are in, so those rows are streamed too.
- **A restore is a queued job.** Both restore routes only store the request and answer 202; the restore runs on the `kite-outbound` queue (`backup.restore` messages, `src/lib/backups/restore-job.ts`), so closing the tab, a deploy or a restart does not cut it off. Its state lives in the `system/backup-restore.json` object on the default store, outside every table a restore replaces: the step, a lease held by the invocation working on it, the validated plan, the safety backup and a checkpoint written before every batch. Each invocation writes for about 20 seconds (`RESTORE_CHUNK_MS`) and queues the next message, so no invocation comes near the CPU limit however large the backup. An invocation that dies anyway leaves its lease behind; once the lease runs out (2 minutes while writing, 15 while validating or taking the snapshot) the redelivered message or the five-minute cron (`runRestoreMaintenance`) continues from the checkpoint. Whether the interrupted batch landed is decided by its last row: looked up by its primary key and compared by a digest of every column it inserted, which only counts once the DELETEs are in, so a live row can never pass for a restored one. A row someone else wrote under that key in the meantime does not match, the batch runs again and fails on the key, and the restore rolls back. DELETEs and kept rows may run twice, so a batch of them simply runs again. After three interruptions in a row a restore rolls back, and a rollback interrupted three times stops and asks for the safety backup to be restored from the admin overview; so does a job without progress for an hour. **Restore previous data** starts a recovery: a restore of that safety backup that takes no snapshot of its own and never rolls back. Until a recovery completes, the admin overview keeps offering it (a failed recovery names the same safety backup again) and no other restore can start (409). The safety backup is listed in the history as soon as it is taken and is written back right after the `backups` table during the restore and the rollback. Only one restore runs at a time (409 otherwise); the state object is created and updated with conditional writes, which the self-hosted file bucket honours too. Database migrations wait while a restore or recovery runs: the automatic ones (`AUTO_APPLY_MIGRATIONS`) are skipped and tried again at the next check, and **Apply** answers 409. Each plan records the applied migrations; a restore that finds them changed starts over if it had not written anything yet and rolls back otherwise. The state also records its format version (`RESTORE_JOB_VERSION`), and a deploy that changes it restarts or rolls back a running restore the same way. Mail that arrives while a restore runs is written into the database being replaced: it is lost if the restore rolls back or replaced by the restore's own rows, so restore when little mail arrives and check the inbound log afterwards. The Backups page follows the job through `GET /api/backups/health` and asks to sign in again once it is done, since the restored sessions replace the current ones. CPU: every writing invocation stops after about 20 seconds, but validating the file, taking the safety snapshot and planning a rollback each run in one invocation, within the Worker's CPU limit (30 seconds by default; `limits.cpu_ms` in `wrangler.jsonc` raises it on paid plans). A backup too large to check in one invocation fails after three attempts without changing anything; raise the limit or restore on Node/Docker, which has none.
- **Restore from the history.** The restore button on a completed backup in [Admin → Backups](/backups) (`POST /api/backups/[id]/restore`) reads the stored file directly, so a backup of any size can be restored without downloading it, and keeps that backup listed afterwards. **Restore from backup** uploads a file instead: the page sends it as the raw request body, which is streamed to `backups/uploads/` in the Backups store and deleted when the job ends (the five-minute cron removes uploads older than a day that a cut-off request left behind). Its size is limited by the platform's request body limit (100 MB on Workers Free and Pro, 200 MB on Business, 500 MB on Enterprise) and to 1 GiB on Node/Docker (`NODE_BACKUP_UPLOAD_MAX_BYTES`, 413 above it); restore anything larger from the history instead, after copying it into the Backups store if it is not there.

### Remote image proxy

Once remote images are allowed for a message, the reader loads them through `GET /api/remote-images` (Workers only; see [Privacy](privacy.md)). It needs no configuration. The optional `REMOTE_IMAGE_RATE_LIMIT` rate limit binding (600 requests per minute per user, in `wrangler.jsonc.example`) caps it; without the binding the proxy is not rate limited. Refusals answer JSON with a status: 400 for an unsafe URL or redirect, 404 when the message does not show the image or the user cannot read it, 413 for an image over 5 MiB, 415 for anything but PNG, JPEG, GIF, WebP or AVIF, 429 over the rate limit, 502 or 504 when the image host fails or takes over 10 seconds, and 503 on Node/Docker.

#### REMOTE_IMAGES_ALLOW_LOOPBACK (dev and test only)

`REMOTE_IMAGES_ALLOW_LOOPBACK=1` lets the remote image proxy (`GET /api/remote-images`) fetch `http` or `https` on `127.0.0.1` at any port other than the app's own, so `e2e/42-remote-images.spec.ts` can serve images from a local server. `localhost`, other loopback and private addresses stay blocked. Like `ALERT_WEBHOOK_ALLOW_INSECURE` it is ignored whenever `NODE_ENV` is `production` and `vite.config.ts` passes it to the Worker only for `vite dev`. Never set it on a deployment.

### Usage statistics

On by default, and never before the owner was told: a new install records the setup page's switch when the first account is created, and an install without a decision (an upgrade) sends nothing until the first nightly (02:00 UTC) report at least an hour after the primary admin first saw its notice (the date the notice named; the notice is drawn on the Admin pages only, so an owner who never opens Admin is never told and nothing is sent; a date announced under the earlier 14-day rule, with no decision yet, moves once to the first 02:00 UTC run at least an hour after the new version runs, logged as `telemetry.start_day_moved_earlier`, and never later; a hidden notice comes back in the same step, and nothing moves under `KITE_TELEMETRY=0` or without a usable collector); an explicit off is final. While statistics are on, the 02:00 UTC cron (both runtimes; `worker.ts` and `server/runtime/scheduler.ts`) posts one pseudonymous heartbeat a day, with counts as ranges (`src/lib/telemetry/heartbeat.ts`); [Privacy](privacy.md#usage-statistics) lists every field. The run that finds the start date reached logs `telemetry.start_day_reached`. It logs `telemetry.heartbeat_sent`, or `telemetry.heartbeat_failed` with `outcome` `rejected` (the collector answered with an error) or `failed` (no answer within 5 seconds, a network error or a database error). Neither carries a response, an error message or a payload value, and a failed heartbeat is not retried until the next day. Turning statistics off asks the collector to erase the install's reports (`src/lib/telemetry/erase.ts`) and logs `telemetry.erase_sent`, or `telemetry.erase_failed` with `outcome` `rejected`, `failed` or `no_endpoint`; the opt-out stands either way and the card shows the id for a request to privacy@midego.net. `KITE_TELEMETRY=0` turns statistics off for the deployment (no notice, nothing sent; the owner can still turn them off), and `KITE_TELEMETRY_URL` points them at another https collector; an empty `KITE_TELEMETRY_URL` sends nothing. Heartbeats go to `https://kite-telemetry.midego.net/v1/heartbeat`, the collector the Kite project runs on Cloudflare: a separate Worker in `deploy/telemetry-collector/` (see [its README](../deploy/telemetry-collector/README.md)). A `.invalid` host in `KITE_TELEMETRY_URL` turns sending off like an empty value; the e2e server uses `https://127.0.0.1:9/v1/heartbeat`, where nothing listens, so the notice can be tested.

### ABUSE_CH_TEST_ORIGIN (dev and test only)

`ABUSE_CH_TEST_ORIGIN=http://127.0.0.1:<port>` (or `http://localhost:<port>`) sends every URLhaus and ThreatFox request, with its path, to that origin instead of abuse.ch, so the Playwright suite can save and test a key against `e2e/support/fake-abuse-ch.ts` without outside network access. Any other value is ignored. Like `ALERT_WEBHOOK_ALLOW_INSECURE` it is ignored whenever `NODE_ENV` is `production` and `vite.config.ts` passes it to the Worker only for `vite dev`. Never set it on a deployment.

## Triage and backlog

Use the bug/task forms and assign a human owner. The task form records P0–P3;
P0 means immediate incident, P1 blocks release, P2 normal, P3 optional. A bug
uses the existing `bug` label. Area is captured in the form rather than assuming
custom labels exist. Review unresolved tasks weekly: confirm owner, next action,
acceptance criteria and blocker, and close obsolete work with a reason. This is
a process; it does not configure a GitHub label taxonomy automatically.

A PR should describe the resulting behavior and actual validation results.
CODEOWNERS routes review but does not enforce it. Before enabling a required
check, verify its exact job name from a successful run. The operator must enable
branch protection/review requirements, dependency security alerts and private
vulnerability reporting separately. No automatic merges are introduced here.
`.github/workflows/pr-report.yml` posts an advisory PR report: its `report` job
runs pull request code with a read-only token, and a separate `comment` job
holds `pull-requests: write`, never checks out PR code, skips forks and
upserts one comment (see [quality checks](quality.md#pr-report)).

### Drive files

Drive (`src/lib/drive/`) keeps file contents under `drive/<itemId>` in the store routed for Drive under **Admin → Storage**, independently of the Mail store used for attachments. Each file row records its store, and metadata lives in the `drive_*` tables (migration 0064). Database backups include the metadata (the `drive` table group, which a configured backup can leave out) but not the contents: identify and back up every bucket holding Drive objects, including stores still named by file rows and old stores retained during migration. Include the default R2 bucket or, on Node, the data directory's `blobs` folder whenever it holds Drive files. Restoring a database backup without the objects leaves rows whose content answers 404. The daily 02:00 UTC module task `purgeDrive` deletes trashed items older than the retention set under Admin → Drive (default 30 days) and aborts uploads nobody finished within three days; it skips while Drive is off for the install. Public link visits are limited by the `DRIVE_LINK_RATE_LIMIT` binding (namespace `1005`, previews `1105`, 60 requests per minute per IP), and password attempts by `LOGIN_RATE_LIMIT` keyed by IP and link.

### Object storage

`src/lib/storage/` decides where each object lives. With no store configured nothing changes, except one cached read of the storage tables (migration 0065) per isolate every 30 seconds. With stores, each class (Mail, Drive, Backups) writes to its routed store, reads fall back from the active store to the previous one (while a migration is pending) and then the default, and routed deletes reach the active, previous and default stores.

- **Logs.** `storage.store_blocked` means a saved endpoint now resolves to a private address and the store is skipped; `storage.config_stale` and `storage.config_unavailable` mean the config read failed and the last known config (or the default store) was used. Presigned URLs and credentials are never logged.
- **Migrations.** Each batch is a `storage.migrate` message on `kite-outbound`. A job leases its cursor, so a duplicate delivery does nothing; a batch that fails is retried and the job stops as failed after five failures in a row (Retry on the Storage page restarts it). The five-minute cron restarts stalled jobs and finishes completed ones after seven days, keeping the old copies.
- **Audit log.** `storage.store_created`, `storage.store_updated`, `storage.store_deleted`, `storage.route_switched`, `storage.migration_started`, `storage.migration_cancelled` and `storage.migration_purged`.
- **Backups.** `storage_stores` and `storage_routes` are in the `system` group (credentials stay sealed); `storage_migrations` is internal. A restore leaves a live storage config alone: when the target already has stores or routes, both tables keep their current rows. Object contents are never in the database backup itself; [full backups](#full-backups) copy the mail objects next to it, and everything else (Drive files) needs a backup of each bucket. Moving the Backups class to another store does not move the copies full backups made: take a new full backup after the switch.
- **`STORAGE_ALLOW_INSECURE_ENDPOINT` (dev and test only).** Allows `http` and loopback endpoints, as the e2e suite's fake S3 needs. Without the flag, or when `NODE_ENV` is `production`, the header does nothing.

### Import jobs

IMAP imports (`src/lib/import/`) run as `import.imap` messages on the agent queue, one run of up to 200 messages or four minutes at a time, and hand the job on to the next message. A run may take longer than its budget by one IMAP command (up to ten minutes), so the capability timeout is 14 minutes, just under the 15-minute limit of a queue invocation. A run holds its job through a lease (`import_jobs.lease_until`): only a run that finds the lease empty or expired can claim the job, and jobs on the same source account run one at a time.

- **Heartbeat.** While a run is alive it renews the lease every minute (`startLeaseHeartbeat`), so the lease is three minutes and a command that takes up to ten minutes does not lose it. A beat that fails is logged (`import.lease_beat_failed`) and retried at the next one. The run stops the heartbeat only after it has closed the source connection, so the lease cannot run out while the socket is still open.
- **Fencing.** The exact `lease_until` value a run last wrote is its token. Every write of a run to the job (progress and the lease renewal in one statement, each folder's progress and status, a beat, handing the job on, an error, finishing, releasing) applies only while the job still carries that value, and a new claim always writes a later one. A run whose lease ran out and was claimed by another therefore cannot save progress, extend or clear the new lease, or finish the job: it finds the write refused (`import.lease_lost` at info level), closes its connection and stops. Pause and Resume keep `lease_until`, so the token survives them; Cancel and a finished job clear it, so a stale run stops too. What such a run already imported is skipped by the other run (duplicate detection).
- **Pause and Resume.** Pause keeps the lease until the running batch stops, so Resume right after cannot start a second run beside it; the run that was running takes the job back, or hands it on, when it stops. Resume also queues a second `import.imap` message delayed to the lease's expiry. Normally it finds the lease held and leaves; if the worker died, nobody renews or releases the lease, and that message claims the job within three minutes of the last beat. If it fires a moment before the lease runs out, the five-minute cron picks the job up on its next tick.
- **Cancel** closes the folders of an account job that were not finished (status `skipped`), and a run that was in flight when Cancel landed, or that fails, closes the ones it left open and stops instead of opening the next folder.
- **Stalled jobs.** The five-minute cron re-queues active jobs whose lease has expired and that have not been updated for two minutes, and cancels jobs paused for more than seven days (erasing their saved password).

### Connected accounts

Connected accounts (`src/lib/external-accounts/`, migration 0079, user guide in [Connected accounts](external-accounts.md)) store sealed IMAP passwords. Connecting needs `APP_ENCRYPTION_KEY`; changing that key makes every saved password unreadable, and the accounts then show **Sign-in failed** until their owners reconnect them.

- **Install switch and permission.** Admin → General → **Allow connected accounts** (`app_settings.external_accounts_enabled`) and `users.can_connect_accounts`. Turning either off sets `external_accounts.suspended_at` on every affected account that still holds a password, whatever its status; edits never move it. The daily 02:00 UTC run (`eraseIdleExternalCredentials`, on both runtimes) erases each password 30 days after its `suspended_at`, marks the account `disabled` and writes an `external_account.credentials_erased` audit row; a failure is logged as `external.credentials_erase_failed`. Turning access back on within the 30 days clears `suspended_at`.
- **Connection attempts** are limited to 10 per user in 10 minutes. Each attempt first writes an `external_account.connection_tested` audit row and then counts the rows in the window, including its own, so parallel requests cannot slip past the limit (no rate-limit binding needed); past it they answer 429. Provider detection (`GET /api/external-accounts/detect`) uses the `LOGIN_RATE_LIMIT` binding per user.
- **Imports from an account** keep no password: each run calls `moduleHost.accounts.sourceLogin` with its job id, core reads the job's owner and account itself, and a removed account fails the job with "The account was removed".
- **Backups** export `external_accounts` with an empty `secret`, and a restore sets every account to `auth_failed` with "Reconnect after restore". A message whose `external_account_id` names an account the backup does not hold (one connected while the backup was being written) is restored with the column empty instead of failing the restore.
- **Sync** (`sync.ts`, spec §6.3). The 5-minute cron (`planExternalSync`, from `worker.ts` and `server/runtime/scheduler.ts`) claims up to 200 due accounts (`sync_enabled`, a password, not suspended, status `active` or `error`, `next_sync_at` passed) in one `UPDATE … RETURNING` that pushes `next_sync_at` 15 minutes ahead, and sends one `{ kind: "accounts.sync", accountId }` per account on `AGENT_QUEUE` (in batches of 100; no new binding). Nothing is planned while the install switch is off or before migration 0079. A run takes the account's 15-minute lease (`lease_until`), checks the switch, the permission, a disabled owner and full access to the target mailbox again, signs in, `EXAMINE`s INBOX and stops there when `UIDNEXT` says nothing arrived. Otherwise it reads flags and sizes with `UID FETCH n:<UIDNEXT − 1> (UID FLAGS INTERNALDATE RFC822.SIZE)`, fetches bodies in steps of at most 25 messages and 90% of the connection's FETCH limit (48 MB Workers, 96 MB Node), checking before each step that the account may still bring in mail (at most 200 messages or 4 minutes per run; the rest continues on a run queued at once); a FETCH that fails is retried message by message on a new connection, the cursor saved after each, and a message that still fails is skipped and named on the account. A run stops 2 minutes before its 15-minute lease ends and caps each IMAP command so none runs past that. It writes each to the Mail store at `external/<accountId>/<uidvalidity>/<uid>.eml` and sends it on `INBOUND_QUEUE` with `source: { kind: "external", accountId, read, starred }`; the cursor (`external_account_folders.last_uid`) advances after each step, only while the run holds its lease. A run that never released its lease (stopped by the platform) is counted as a transient failure by the next one. Messages over 25 MB are skipped and named in the account's recent problems. A new `UIDVALIDITY` resets the cursor to the last two days (`UID SEARCH SINCE`) and the Message-ID check drops what Kite has. **Check now** (`POST /api/external-accounts/[id]/sync`) queues a run at most once a minute.
- **Delivery** (`src/lib/email/inbound-external.ts`) puts synced mail into the account's mailbox through the shared delivery half (`deliverInboundMessage` in `inbound-deliver.ts`): no domain routing, reject rules, account forwarding or auto-reply; a message whose Message-ID the mailbox already holds is dropped with its object; an object whose account was removed is deleted, and one whose owner is refused for now is deleted with the account's cursor moved back so it is fetched again later. Duplicates are matched only against the same account's mail, imports and Kite's own sends. Synced mail belongs to the mailbox's owner. Only Gmail and Google Workspace accounts get the provider's topmost `Authentication-Results` (authserv-id `mx.google.com`, with a `Received … by mx.google.com` above it).
- **Errors** (`classifySyncError`, `sync-utils.ts`). A failed sign-in or a password the key no longer opens sets `auth_failed`, a certificate problem `tls_failed`, a missing INBOX or a server Kite refuses `error`; all three stop checking (`next_sync_at` empty) until the owner reconnects, edits or presses Check now. Throttling (`[THROTTLED]`, `[LIMIT]`) retries from 15 minutes, other failures (timeouts, `[UNAVAILABLE]`, DNS) from twice the interval, doubling to at most 6 hours with ±20% jitter; after a day of failures (three or more in a row) the account shows `error` and is tried every 6 hours. State changes write `external_account.sync_failed` (with the class, never server text or addresses) and `external_account.sync_recovered` audit rows; a newly failed sign-in sends the owner a realtime notice once, and `GET /api/external-accounts/attention` feeds the sidebar notice. Logs: `external.sync.checked`, `external.sync.failed`, `external.sync.refused_at_delivery`, `external.sync.duplicate_dropped`, `external.sync.backlog`, `external.sync_plan_failed` (account ids, counts and the class only).
- **Capacity.** One tick claims at most 200 accounts, so at the 5-minute interval one install checks about 2,400 accounts an hour; more due accounts wait for later ticks, oldest first, and each tick that leaves some behind logs `external.sync.backlog` with how many are still due (raise the interval of some accounts, or expect checks later than their interval). On Workers each run is its own queue invocation (`AGENT_QUEUE` batch size 1) and holds one socket and at most one FETCH (48 MB) in memory. On Node the agent queue runs at most five messages at once in the server process, so five syncs (or imports, or agent jobs) share it, each holding up to one 96 MB FETCH in memory; plan memory for that, and expect a large backlog to drain at five accounts at a time. Analytics Engine gets an `external_sync` event per run (`new_mail`, `checked` or the failure class).
- **Send-as** (migration 0083, `external_accounts.smtp_verified_at`) submits through the account's own SMTP server (`src/lib/external-accounts/submit.ts`). Logs: `external.submit.sent` and `external.submit.failed` (account id, message id, attempt, `action` retry or fail, `deliveryUnknown`, `authFailed`; never addresses, credentials or server text), `external.append_sent.saved` and `external.append_sent.failed` for the Sent copy (`accounts.append_sent` messages on `OUTBOUND_QUEUE`, three tries). A `4xx` puts the outbound job back to `queued` with the reply in `outbound_jobs.error` and re-sends `email.scheduled` with `attempt` after 60 s, then 300 s; a send whose connection broke after the data went out fails as "Delivery unknown" and is never retried. The sent bytes are kept at `sent/<messageId>.eml` in the Mail store and named on the queued row (`raw_r2_key`) before submission, which storage migration moves like any raw message; a send that certainly did not go out deletes them, "delivery unknown" keeps them. While a submission runs it renews `outbound_jobs.updated_at` every minute and once more just before `DATA` (refusing to send when the job was taken back), so the 10-minute stalled-send recovery never fires during a slow provider's answer. Memory: on Workers (128 MB isolates) a message near the 25 MB limit is held as attachments plus its MIME bytes, about twice its size; Kite streams the dot-stuffing but not the MIME build.

## Recovery and data handling

Start with [incident response](runbooks/incident.md),
[email delivery triage](runbooks/mail-delivery.md), or
[backup and deployment recovery](runbooks/recovery.md).
Use [PII handling](pii-handling.md) for all evidence.

## Documentation upkeep

Run `node scripts/docs-generate.mjs` after route exports change, and
`node scripts/docs-check.mjs` before handoff. The generated inventory describes
paths and explicit methods, not authentication, schemas or an OpenAPI contract;
update `docs/api.md` for behavior changes. The freshness check verifies structural
contracts rather than claiming that prose is current solely from timestamps.

## Known security debt

The October 2026 dependency review still reports high and moderate npm
advisories after the critical Next.js fix. Passing source scans do not clear
dependency advisories. Inspect `npm audit` and `npm audit --omit=dev`, trace each
affected dependency/override and prepare a tested update; do not apply forced
major updates or waive advisories simply to make validation pass. The lockfile
is the source of truth for the deployment under review.
