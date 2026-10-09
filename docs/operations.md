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

1. In GitHub, open the commit's checks and confirm `Workers Builds: kite` (app `cloudflare-workers-and-pages`) passed. `.github/workflows/deploy-record.yml` then records a GitHub deployment; the repository's **Deployments → production** entry carries the commit and the Worker version.
2. In the Cloudflare dashboard open Workers & Pages → `kite` → Deployments and note the new version id. Keep the previous id for the comparison below.
3. Open Logs (Observability) and search for these JSON events:
   - `http.request_completed`: 5xx responses, 4xx responses and slow requests (over 1000 ms).
   - `http.request_failed`: an exception escaped a route.
   - `queue.processing_failed`: a queue message failed and will be retried.
   - `inbound.enqueue_failed`: the email handler could not store or enqueue inbound mail.
   - `backup.scheduled_failed`: the scheduled backup failed.
   - `alerts.*`: the operational alert run (see [Operational alerts](#operational-alerts)).
4. Open Metrics and compare requests, errors and CPU time with the period before the deploy.
5. On the Admin overview, the database card (`src/components/admin-update-card.tsx`, `GET /api/admin/migrations`) shows pending D1 migrations. Apply them from there; deploys never migrate for you.
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

The `rule` values are `backup_failed`, `outbound_failed`, `outbound_stuck` and `webhook_exhausted`. Only a test send adds `"test": true`.

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

While any rule is active, every admin sees a banner at the top of the dashboard listing each alert with its count and a link to the page to check. It reads `GET /api/admin/alerts/active`, which only evaluates the rules: it sends nothing and writes no state. The banner loads when the page opens and refreshes every 5 minutes; users who are not admins never request it. **Dismiss** hides it in that browser until the set of active alerts changes (a new rule fires, or a rule clears and returns); a count changing alone does not bring it back. Dismissal is stored in the browser under `kite-dismissed-alerts`.

#### Blind spots

Email alerts need working outbound sending, and webhook alerts need the receiver to be reachable. Configure the webhook so a sending outage still reaches you. If both fail, check the logs for `alerts.notify_failed` and `alerts.channel_failed`.

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
