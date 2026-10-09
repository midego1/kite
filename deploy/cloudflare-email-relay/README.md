# Kite email relay

A small Cloudflare Worker for self-hosted Kite installs that want to keep
receiving mail through Cloudflare Email Routing (no port 25, no MX changes).

1. `npm install`, then `npx wrangler secret put KITE_URL` (your server's
   public URL, e.g. `https://mail.example.com`) and
   `npx wrangler secret put INBOUND_WEBHOOK_SECRET` (the same value as in the
   server's `.env.docker`).
2. `npm run deploy`.
3. In the Cloudflare dashboard, under Email Routing for your zone, route the
   catch-all, or the addresses you want, to the `kite-email-relay` Worker.

A relay deployed before the rename to Kite (`mailflare-email-relay`, with a
`MAILFLARE_URL` secret) keeps working: the server accepts both the old
`X-Mailflare-*` and the new `X-Kite-*` request headers, and the relay reads
`MAILFLARE_URL` when `KITE_URL` is not set. Update the server before the relay.

Each message is posted to `/api/inbound` on your server with an HMAC
signature. The server stores it and replies with the routing decision, so
reject rules and forwarding rules still act at Cloudflare's edge. If the server
is unreachable the message is rejected with a retry hint.

## Local validation

From the repository root, run `npm run test:relay` for handler tests and
`npm run test:relay:integration` for real local workerd delivery into a local
HTTP receiver. These use synthetic mail and need no Cloudflare credentials.
Run `npm run check:mission` to validate both packages and browser flows.
See [Mission readiness](../../docs/mission-readiness.md) for setup and manual QA.

`npm --workspace kite-email-relay run test:list` discovers handler test names without running their bodies (Node reports every test skipped). It imports these trusted test modules but contacts no receiving server.
