# Kite telemetry collector

A small, standalone Cloudflare Worker (`kite-telemetry`) that receives the opt-in, pseudonymous usage statistics Kite installs send once a day, erases them on request and publishes totals. It runs at `https://kite-telemetry.midego.net`, the app's default (`DEFAULT_TELEMETRY_URL` in `src/lib/telemetry/telemetry-utils.ts`; operators can point `KITE_TELEMETRY_URL` elsewhere, or set it empty to send nothing). It is not part of the Kite app, its build or its deploy, and Kite deployments never need it.

What Kite sends, when, and how operators turn it off is documented in [Privacy → Usage statistics](../../docs/privacy.md#usage-statistics-opt-in). The sender is `src/lib/telemetry/` in the app.

## Operator and data protection

- **Operator (controller):** Michiel de Gooijer (midego).
- **Contact for questions and data requests:** privacy@midego.net. An install id from Admin → General is enough to find and erase an install's reports.
- **Legal basis:** consent. Nothing is sent until the owner of an install turns statistics on, and turning them off withdraws it and erases the reports (below).
- **Processor:** Cloudflare (Workers, D1 and the `midego.net` zone).
- **Retention:** daily reports, the only rows with an install id, are kept for 90 days. The daily cron then counts them into per-day totals without ids (`aggregates`) and deletes them.
- **Pseudonymous, not anonymous:** the install id links one install's daily reports. Requests from installs on Cloudflare Workers carry a `CF-Worker` header that Cloudflare adds, naming the sending Worker's zone (the operator's domain or `workers.dev` subdomain), which Kite cannot remove; Node/Docker installs arrive from their server's IP address. The collector reads, logs and stores neither, and `observability` is off in `wrangler.jsonc` so Workers Logs do not record requests. Cloudflare still sees the connecting address to route the request, and Cloudflare's zone analytics for `midego.net` may record a sample of requests with their IP addresses.

Do not add code that reads `CF-Worker`, `CF-Connecting-IP` or similar headers: the privacy page promises they are ignored.

## API

### `POST /v1/heartbeat`

`Content-Type: application/json`, at most 2048 bytes, exactly these keys (`src/validate.ts`):

```json
{
	"telemetry_schema_version": 2,
	"install_id": "3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e",
	"version": "2026.10.26.0",
	"runtime": "workers",
	"users_total": "2-5",
	"users_active_1d": "1",
	"users_active_7d": "2-5",
	"users_active_30d": "2-5",
	"mailboxes_total": "2-5",
	"mailboxes_active_1d": "2-5",
	"inbound_1d": "1-10",
	"outbound_1d": "1-10",
	"modules_enabled": ["calendar", "drive"]
}
```

- `install_id` is a lowercase UUID v4, `version` a calendar version or `unknown`, `runtime` `workers` or `node`, and `modules_enabled` at most 32 distinct slugs.
- Counts are ranges, never numbers: the `users_*` and `mailboxes_*` fields are one of `0`, `1`, `2-5`, `6-20`, `21-100`, `100+`; `inbound_1d` and `outbound_1d` one of `0`, `1-10`, `11-100`, `101-1000`, `1000+`.
- Version 1 (exact counts) is refused with `unsupported_schema_version`.
- Answers `204` when stored, `400 { "error": "<code>" }` for a body that does not match (an unknown or missing key, a wrong type or value; the code names the field, never a value), `413` over the size limit or without `Content-Length`, `415` for another content type and `405` for another method.
- Stores the fields under the collector's own UTC date. A second heartbeat from the same install on the same day replaces the first.

### `DELETE /v1/installs/<install_id>`

Erases every daily report of that install id. Knowing the random id is enough; there is no other authentication. Kite calls it when the owner turns statistics off. Answers `204` whether or not there were reports (so it does not reveal which ids exist), `400` for an id that is not a lowercase UUID v4, `405` for another method and `429` over the rate limit: 30 requests a minute across all callers (the `ERASE_RATE_LIMIT` binding; the collector never reads IP addresses, so the limit is shared). Totals already rolled up after 90 days hold no ids and are not affected.

### `GET /v1/summary`

Public, cached for an hour, `Access-Control-Allow-Origin: *`. Totals only, never an install id:

```json
{
	"generated_at": "2026-10-26T09:00:00.000Z",
	"installs_30d": 80,
	"versions": [{ "version": "2026.10.26.0", "installs": 50 }],
	"runtimes": [{ "runtime": "workers", "installs": 70 }, { "runtime": "node", "installs": 10 }],
	"modules": [{ "module": "calendar", "installs": 65 }],
	"ranges": { "users_total": { "1": 40, "2-5": 30, "6-20": 10 }, "inbound_1d": { "11-100": 50 } },
	"installs_by_day": [{ "day": "2026-10-25", "installs": 41 }]
}
```

- `installs_30d`, `versions`, `runtimes`, `modules` and `ranges` describe the installs that reported in the last 30 days, by their latest report. `ranges` has all eight range fields.
- `installs_by_day` counts the installs that reported on each UTC day of the last 365, from the daily rows and, past 90 days, from the totals.

### `GET /v1/stats`

The summary plus install counts for the operator. Needs `Authorization: Bearer <STATS_TOKEN>`; answers `401` otherwise, and always while `STATS_TOKEN` is unset. Adds `"installs": { "total", "active_1d", "active_7d", "active_30d" }`: `total` counts install ids within the 90 days, and `active_Nd` those with a report dated on or after the UTC day N days ago (so `active_1d` covers today and yesterday, because reports arrive around 02:00 UTC).

## Data kept

- `daily`: one row per UTC day and install with the report's fields. Kept 90 days (`RAW_RETENTION_DAYS` in `src/index.ts`).
- `aggregates`: per UTC day, how many installs reported (`installs`) and how many reported each version, runtime, module and range. No install id. Kept.
- The cron (`30 4 * * *`, `rollUpOldDays`) counts daily rows older than 90 days into `aggregates` and deletes them, in one transaction.
- No IP address, user agent, time of day or other request header is read or stored.

Anyone can post a heartbeat, so the figures are indicative: a bogus install inflates them.

## Deploy

The collector is deployed by hand from this directory; nothing in CI deploys it. You need the Cloudflare account that holds the `midego.net` zone, with Wrangler logged in to it (`npx wrangler login`).

`kite-telemetry.midego.net` currently resolves through the `*.midego.net` wildcard record to another server. That is fine: the Worker custom domain in `wrangler.jsonc` (`routes` with `custom_domain: true`) creates a proxied record for exactly `kite-telemetry.midego.net` with its own certificate, and an exact record takes precedence over a wildcard. Do not create a DNS record for that name by hand; if one exists (not the wildcard), delete it first, or the deploy refuses the custom domain.

From the repository root:

```sh
cd deploy/telemetry-collector
npm install --no-package-lock

# 1. The database. Copy the printed database_id into wrangler.jsonc, replacing REPLACE_WITH_YOUR_D1_DATABASE_ID
#    (answer "no" if Wrangler offers to add a new binding itself: the DB binding is already there).
npx wrangler d1 create kite-telemetry

# 2. The tables.
npx wrangler d1 migrations apply DB --remote

# 3. The token for GET /v1/stats. Paste the value when asked and keep it in your password manager; never commit it.
openssl rand -hex 32
npx wrangler secret put STATS_TOKEN

# 4. Deploy. This also creates the custom domain, its DNS record and certificate (allow a few minutes for the certificate).
npx wrangler deploy

# 5. Check it.
curl -i https://kite-telemetry.midego.net/v1/stats     # HTTP/2 401
curl -i https://kite-telemetry.midego.net/v1/summary   # HTTP/2 200, {"installs_30d":0,...}
```

If `curl` reports a certificate problem or the old server answers, the certificate or DNS is still being issued; wait a few minutes and try again (`dig +short kite-telemetry.midego.net` should show Cloudflare addresses, not `159.195.70.154`).

The `database_id` is not a secret: commit it in a pull request so later deploys use the same database. The `STATS_TOKEN` must never be committed. Read the statistics with `curl -H "Authorization: Bearer $STATS_TOKEN" https://kite-telemetry.midego.net/v1/stats`, and never paste the token into issues, pull requests or chat.

Installs that opted in start reporting at their next 02:00 UTC run once this is live; until then their heartbeats fail and are not retried that day.

To erase an install by hand (an emailed request): `curl -i -X DELETE https://kite-telemetry.midego.net/v1/installs/<install id>` answers `204`.

To run a collector somewhere else (a fork, a test), change `name`, `routes` and the D1 database here and set `KITE_TELEMETRY_URL=https://<that host>/v1/heartbeat` on the Kite deployments that should use it.

## Tests

`node --test tests/telemetry-collector.test.mjs` from the repository root (part of the app's `npm run test:app`) covers the validator, storage, erasure, the summary, stats and the 90-day roll-up against SQLite. `npm run typecheck` here type-checks the Worker, and `npx wrangler deploy --dry-run` builds it without uploading.
