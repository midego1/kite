# Kite telemetry collector

A small, standalone Cloudflare Worker that receives the opt-in anonymous usage heartbeat Kite installs send once a day, and answers aggregate statistics for the Kite project. It is not part of the Kite app, its build or its deploy: the project runs one collector, and Kite deployments never need it.

What Kite sends, when, and how operators turn it off is documented in [Privacy → Usage statistics](../../docs/privacy.md#usage-statistics-opt-in). The sender is `src/lib/telemetry/` in the app.

## API

### `POST /v1/heartbeat`

`Content-Type: application/json`, at most 2048 bytes, exactly these keys (`src/validate.ts`):

```json
{
	"telemetry_schema_version": 1,
	"install_id": "3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e",
	"version": "2026.10.26.0",
	"runtime": "workers",
	"users_total": 3,
	"users_active_1d": 1,
	"users_active_7d": 2,
	"users_active_30d": 3,
	"mailboxes_total": 4,
	"mailboxes_active_1d": 2,
	"inbound_1d": 10,
	"outbound_1d": 5,
	"modules_enabled": ["calendar", "drive"]
}
```

- `install_id` is a lowercase UUID v4, `version` a calendar version or `unknown`, `runtime` `workers` or `node`, every count an integer from 0 to 2147483647, and `modules_enabled` at most 32 distinct slugs.
- Answers `204` when stored, `400 { "error": "<code>" }` for a body that does not match (an unknown or missing key, a wrong type or range; the code names the field, never a value), `413` over the size limit or without `Content-Length`, `415` for another content type and `405` for another method.
- Stores the fields under the collector's own UTC date. A second heartbeat from the same install on the same day replaces the first.

### `GET /v1/stats`

Needs `Authorization: Bearer <STATS_TOKEN>`; answers `401` otherwise, and always while `STATS_TOKEN` is unset.

```json
{
	"generated_at": "2026-10-26T09:00:00.000Z",
	"installs": { "total": 120, "active_1d": 40, "active_7d": 61, "active_30d": 80 },
	"usage": {
		"installs": 40,
		"users_total": 210,
		"users_active_1d": 90,
		"users_active_7d": 150,
		"users_active_30d": 190,
		"mailboxes_total": 300,
		"mailboxes_active_1d": 120,
		"inbound_1d": 9000,
		"outbound_1d": 1200
	},
	"versions": [{ "version": "2026.10.26.0", "installs": 50 }],
	"runtimes": [{ "runtime": "workers", "installs": 70 }, { "runtime": "node", "installs": 10 }],
	"modules": [{ "module": "calendar", "installs": 65 }]
}
```

- `installs.total` counts every install id seen within the retention (see below). `active_Nd` counts install ids with a heartbeat dated on or after the UTC day N days ago (so `active_1d` covers today and yesterday, because heartbeats arrive around 02:00 UTC).
- `usage` sums the latest heartbeat of each install in the `active_1d` set.
- `versions` and `runtimes` group the installs seen in the last 30 days by their latest heartbeat; `modules` counts, among the latest heartbeat of each of those installs, how many have each module on.

## Data kept

- `installs`: install id, first and last UTC day seen, last version and runtime.
- `daily`: one row per UTC day and install with the heartbeat's fields.
- The cron (`30 4 * * *`) deletes `daily` rows older than `DAILY_RETENTION_DAYS` (default 400, at least 31) and `installs` rows not seen for that long.
- No IP address, user agent, time of day or other request header is read or stored, and `observability` is off in `wrangler.jsonc` so Workers Logs do not record requests. Installs on Cloudflare Workers arrive from a Cloudflare egress address with a `CF-Worker` header that Cloudflare adds, naming the sending Worker's zone (the operator's domain or `workers.dev` subdomain); Node/Docker installs arrive from their server's IP address. The collector ignores both. Cloudflare still sees the connecting IP to route the request.
- To remove an install on request (the owner sees its id under Admin → General): `npx wrangler d1 execute kite-telemetry --remote --command "DELETE FROM daily WHERE install_id = '<id>'; DELETE FROM installs WHERE install_id = '<id>'"`.

Do not add code that reads `CF-Worker`, `CF-Connecting-IP` or similar headers: the privacy page promises they are ignored.

Anyone can post a heartbeat, so the figures are indicative: a bogus install inflates them. Add a Cloudflare rate-limiting rule on `/v1/heartbeat` (for example 10 requests per minute per IP) if that becomes a problem.

## Deploy

The collector is deployed by hand by whoever runs it; it is not in CI.

1. `cd deploy/telemetry-collector && npm install`
2. `npx wrangler d1 create kite-telemetry` and put the returned `database_id` in `wrangler.jsonc`.
3. `npm run db:migrate:remote` (or `npm run db:migrate:local` with `npm run dev` to try it locally).
4. `npx wrangler secret put STATS_TOKEN` with a long random value (`openssl rand -hex 32`). Never commit it.
5. `npm run deploy`, then attach a custom domain (Workers → `kite-telemetry-collector` → Settings → Domains & Routes), for example `telemetry.<your-domain>`.
6. Put `https://<that host>/v1/heartbeat` in `DEFAULT_TELEMETRY_URL` in `src/lib/telemetry/telemetry-utils.ts` of the app and release it. Until then the app's default is a `.invalid` placeholder and installs send nothing, unless an operator sets `KITE_TELEMETRY_URL`.

Read the statistics with `curl -H "Authorization: Bearer $STATS_TOKEN" https://<that host>/v1/stats`. Do not paste the token into issues, pull requests or chat.

## Tests

`node --test tests/telemetry-collector.test.mjs` from the repository root (part of the app's `npm run test:app`) covers the validator, storage, stats and retention against SQLite.
