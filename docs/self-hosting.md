# Self-hosting Kite (Docker)

Kite can run as a single container on any host instead of Cloudflare
Workers. The same code serves both; the container provides its own database
(SQLite on a volume), blob storage (files on the same volume), job queue,
realtime WebSocket, backup schedule and an SMTP listener for inbound mail.

## Quick start

```bash
git clone https://github.com/midego1/kite && cd kite
cp .env.docker.example .env.docker      # edit: how to receive and send mail
docker compose up -d --build
```

Open `http://your-host:3000/setup`, create the admin account and add your
domain. All data lives in the `mailflare-data` volume (`/data` in the
container): the SQLite database, raw messages, attachments and backups.

Behind a reverse proxy, set `APP_URL=https://mail.example.com` so links in
password-reset mail and the JMAP session point at the public address, and
forward WebSocket upgrades for `/api/realtime`.

## Receiving mail

Pick one; both can be on at once.

**Built-in SMTP listener (default).** The container listens on port 25 and
accepts mail for every domain you add. Point the domain's MX record at the
host, set `MAIL_HOSTNAME` to that host's name, and make sure port 25 is
reachable from the internet (several clouds block it by default; Hetzner and
most VPS providers do not). The domain page in the app lists the MX, SPF and
DMARC records to create. Domain routing rules work as on Cloudflare: reject
rules answer the sender with a 550 during delivery, forward rules relay the
message through your outbound SMTP.

The listener checks SPF, DKIM and DMARC itself (with
[mailauth](https://github.com/postalsys/mailauth)), from the connecting
address, the HELO name and the envelope sender, and records the result as an
`Authentication-Results` header under its own name (`MAIL_HOSTNAME`, else the
machine's host name), which the spam filter reads the way it reads
Cloudflare's. Any `Authentication-Results` header already in the message is
ignored, since the sender could have written it. The checks use the
container's DNS resolver; when they cannot finish within 10 seconds, the mail
is delivered with its authentication unknown, as before. Kite also adds a
`Received` header naming the connecting address (see
[Sender authentication](spam-protection.md#sender-authentication)).

The listener limits what one sender can hold: 100 open sessions in total and
10 from one address (more get `421`), 50 recipients per message (the next one
gets `452`, and the sending server retries it later), and 60 seconds of
silence before a session is closed. A message over `SMTP_MAX_SIZE` is
refused with `552` without being kept in memory.

**The listener must see each sender's real address.** SPF, DMARC and the
per-address limit all depend on the address the connection comes from. When
something in front of Kite replaces it with its own:

- If that address is private, loopback, link-local or CGNAT (`172.17.0.1`,
  `10.x`, `100.64.x`, `127.0.0.1`, or their IPv6 forms), Kite does not check
  SPF. It still checks DKIM, which does not depend on the address, and counts
  DMARC only when an aligned DKIM signature makes it pass, never as a failure.
  Each such message's spam details say so, and Kite logs a warning once per
  start.
- If it is a public address of your own (a load balancer elsewhere), SPF
  fails for every sender, so DMARC fails for all mail without an aligned DKIM
  signature, and a domain publishing `p=reject` or `p=quarantine` goes to Spam.
- Either way the 10-sessions-per-address limit applies to all senders together.

Check the `Received` header at the top of a delivered message's source: the
address in brackets must be the sending server's, not your proxy's. What
keeps it:

- **Docker (rootful)** with its default iptables port publishing (`ports:
  "25:25"`, as in `docker-compose.yml`) keeps the client address. The
  userland proxy (`docker-proxy`) replaces it, and it handles the traffic when
  Docker's iptables rules are off (`"iptables": false`) or the connection
  comes from the host itself. `network_mode: host` also keeps it.
- **Rootless Docker or Podman**: the default RootlessKit port driver replaces
  the address. Use host networking, or the `slirp4netns` port driver
  (`DOCKERD_ROOTLESS_ROOTLESSKIT_PORT_DRIVER=slirp4netns`), which keeps it.
- **Load balancers and TCP proxies**: use one that passes the client address
  through at the network level (AWS NLB with client IP preservation,
  Kubernetes `externalTrafficPolicy: Local`). A proxy that opens its own
  connection to Kite (HAProxy, nginx `stream`, Traefik TCP) hides it, and the
  listener does not read the PROXY protocol.

Optional: `SMTP_TLS_KEY` and `SMTP_TLS_CERT` (paths inside the container)
enable STARTTLS with your own certificate. Without them STARTTLS is not
offered, which is safe but means transport encryption depends on the sender.

**Cloudflare Email Routing relay.** Keep MX on Cloudflare and deploy the
Worker in `deploy/cloudflare-email-relay`. It posts each message to
`/api/inbound` on your server, signed with `INBOUND_WEBHOOK_SECRET`, and acts
on the reject or forward decision the server returns. Cloudflare's SPF, DKIM
and DMARC results count because the relay also signs the header map it sends;
after updating the server, redeploy the relay so it sends that signature,
otherwise its mail counts as unverified and admins see a "redeploy the relay"
operational alert. The header map signature uses a key derived from
`INBOUND_WEBHOOK_SECRET`; the server still accepts the earlier form, made with
the secret itself, from relays deployed before that change, but logs
`relay.headers_signature_legacy` with a low-priority "update the relay"
operational alert, and stops accepting it in the first release on or after
2027-01-31 ([#118](https://github.com/midego1/kite/issues/118)); after that such
mail counts as unverified.
Set
`SMTP_INBOUND_PORT=0` if you do not want the listener at all.

## Sending mail

**Any SMTP relay.** `SMTP_URL=smtps://user:pass@host:465` (or `smtp://`
with STARTTLS). Works with your hosting provider's relay, Amazon SES,
Postmark, Mailgun, or a Postfix you run. Set
`SMTP_TLS_REJECT_UNAUTHORIZED=false` only for a relay with a self-signed
certificate on a private network.

**Cloudflare Email Sending.** `CF_ACCOUNT_ID` plus a `CF_TOKEN` with Email
Sending: Edit. The domain must be a Cloudflare zone with Email Sending set
up; Kite calls the REST API, no Workers plan needed.

**Resend or Amazon SES, per domain.** Instead of one global relay, each domain
can send through Resend or SES with their APIs (no SMTP involved), and receive
through them too, once Kite can manage the domain's DNS with `CF_TOKEN`.
Add the credentials on the domain page, or set `RESEND_API_KEY` /
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_REGION`. Receiving
through either needs `APP_URL` set to your public HTTPS address. See
[Sending and receiving providers](providers.md). Using SES as a plain SMTP
relay through `SMTP_URL`, described above, still works and needs none of this.

## Cloudflare zone management (optional)

If `CF_TOKEN` can also edit DNS and Email Routing on your zones, adding a
domain configures Email Routing and the sending subdomain automatically,
exactly as on Workers. Without it, domains are recorded as manually managed
and the DNS page shows what to set by hand.

## Configuration reference

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `/data` | SQLite database, blobs and backups |
| `APP_URL` | request origin | Public URL behind a proxy; also the only origin used in password reset links (no reset mail is sent without it) |
| `TRUST_PROXY` | unset | Set to `true` behind a reverse proxy so the client IP is read from `X-Forwarded-For`; otherwise forwarded headers are ignored for rate limiting |
| `SETUP_TOKEN` | generated | Token required to create the first admin. When unset in production a random one is generated at start and printed in the log with the `/setup?setup_token=…` link |
| `APP_ENCRYPTION_KEY` | unset | Encrypts provider keys and webhook secrets stored in the database. Plaintext values keep working and are encrypted when next saved; losing the key makes them unreadable |
| `SMTP_INBOUND_PORT` | `25` | Inbound SMTP; `0` disables |
| `MAIL_HOSTNAME` | `mail.<domain>` | Host the MX record points at; SMTP banner |
| `SMTP_MAX_SIZE` | 36 MiB | Largest raw inbound message; allows for encoding overhead on up to 25 MB of attachments. Oversized mail receives an SMTP rejection, which the sender's mail provider can report as a delivery failure. Mail over the MIME structure limits, or that cannot be parsed, gets `552` too ([inbound mail limits](operations.md#inbound-mail-limits)). |
| `SMTP_TLS_KEY`, `SMTP_TLS_CERT` | unset | STARTTLS certificate for the listener |
| `SMTP_URL` | unset | Outbound relay |
| `SMTP_TLS_REJECT_UNAUTHORIZED` | `true` | Trust self-signed relay certificates when `false` |
| `CF_ACCOUNT_ID`, `CF_TOKEN` | unset | Cloudflare Email Sending, and zone management if the token allows |
| `RESEND_API_KEY` | unset | Resend key, used when none is saved in the app |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` | unset | Amazon SES credentials, used when none are saved in the app |
| `INBOUND_WEBHOOK_SECRET` | unset | Enables `/api/inbound` for the relay Worker |
| `URLHAUS_AUTH_KEY` | unset | abuse.ch Auth-Key; checks links, link hosts and attachment hashes of risky incoming mail against URLhaus and ThreatFox. Takes precedence over a key saved in Admin → General (see [Spam protection](spam-protection.md#urlhaus-and-threatfox-lookups-optional)) |
| `ABUSE_CH_AUTH_KEY` | unset | Another name for `URLHAUS_AUTH_KEY`, used only when that is unset |
| `KITE_TELEMETRY` | unset | `0` (or `false`, `off`, `no`) turns usage statistics off for the deployment: nothing is sent, the setup switch is off and locked, no notice appears, and the owner cannot turn them on in Admin → General (only off). Without it statistics are on by default, explained at setup, and existing installs get a notice first, and reports start at the first 02:00 UTC run at least an hour after the owner saw it. No value turns them on (see [Privacy](privacy.md#usage-statistics)) |
| `KITE_TELEMETRY_URL` | unset | https address the daily usage heartbeat goes to, unless statistics are off, instead of the project's collector at `https://kite-telemetry.midego.net/v1/heartbeat` (run by the Kite project on Cloudflare). Set but empty sends nothing |
| `TURNSTILE_SECRET_KEY` | unset | Bot protection on login and reset forms (`NEXT_PUBLIC_TURNSTILE_SITE_KEY` at build time) |
| `AI_BASE_URL` | unset | OpenAI-compatible model API base URL for the assistant |
| `AI_API_KEY` | unset | Server-only key for that model API |
| `AI_MODEL` | `gpt-4o-mini` | Model ID supported by the configured API |
| `EXTERNAL_ACCOUNTS_ALLOW_PRIVATE_HOSTS` | unset | Lets IMAP imports reach a mail server on your LAN: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` and IPv6 `fc00::/7` (a mail server or another container beside Kite). Loopback, link-local (including the cloud metadata address) and `0.0.0.0/8` stay refused. Still TLS or STARTTLS with a verified certificate (for a private CA, add it with Node's `NODE_EXTRA_CA_CERTS`). Ignored on Workers |
| `EXTERNAL_ACCOUNTS_EXTRA_PORTS` | unset | Comma-separated ports IMAP imports may use besides 993 and 143, for a bridge such as DavMail or Proton Mail Bridge (`1143`). Usually needs `EXTERNAL_ACCOUNTS_ALLOW_PRIVATE_HOSTS` too, with the bridge in its own container, since loopback is never allowed. Ignored on Workers |
| `STORAGE_ALLOW_PRIVATE_ENDPOINTS` | unset | Lets an S3-compatible store live on a private or LAN address (MinIO beside the server), over `http` or `https`; see [Object storage](#object-storage-optional) |
| `STORAGE_S3_ENDPOINT`, `STORAGE_S3_BUCKET`, `STORAGE_S3_ACCESS_KEY_ID`, `STORAGE_S3_SECRET_ACCESS_KEY` | unset | An S3-compatible store defined by the environment, listed read-only under Admin → Storage |
| `STORAGE_S3_REGION`, `STORAGE_S3_ADDRESSING` | `us-east-1`, `path` | Signing region and `path` or `virtual` addressing of that store |
| `STORAGE_S3_CLASSES` | unset | Comma-separated classes (`mail`, `drive`, `backups`) the environment store holds while no route is saved for them |

## Object storage (optional)

Files live in `DATA_DIR/blobs` unless you route them elsewhere. **Admin → Storage** adds S3-compatible stores and picks, per class (Mail, Drive, Backups), where new objects go, with the same checks, CORS help and migrations as on Workers (see [Deployment](deployment.md#object-storage-optional)). It needs `APP_ENCRYPTION_KEY`.

MinIO (or another S3 service) next to Kite usually has a private address, which the endpoint guard refuses unless `STORAGE_ALLOW_PRIVATE_ENDPOINTS=1` is set. Use path-style addressing for MinIO. For Drive, the browser must reach the store too: its address must be one the users' browsers can open, and its CORS rule must allow Kite's origin (**Apply CORS** sets it on MinIO).

To set a store without the UI, define it in the environment:

```
STORAGE_S3_ENDPOINT=https://minio.example.internal:9000
STORAGE_S3_BUCKET=kite
STORAGE_S3_ACCESS_KEY_ID=...
STORAGE_S3_SECRET_ACCESS_KEY=...
STORAGE_S3_CLASSES=mail,drive,backups
```

The store appears read-only under Admin → Storage. A route saved in the UI wins over `STORAGE_S3_CLASSES`. Kite cannot set this store's CORS rule, so add it by hand before using it for Drive.

## Operations

- **Backups.** The daily 02:00 UTC backup and the admin Backups page work
  unchanged; files land under `/data/blobs/backups`. Back up the whole volume
  for a full copy.
- **Drive files.** Drive stores file contents under `/data/blobs/drive`.
  Backups made from the admin Backups page hold only their names, folders,
  shares and links, so back up the volume to keep the files. Uploads pass
  through the server in 32 MiB parts; a reverse proxy in front of Kite must
  accept request bodies of that size (for nginx, `client_max_body_size 33m`).
  When Drive is routed to an S3 store, browsers send the parts to the store
  directly and the server never sees them.
- **Updates.** Pull the new image and recreate the container; migrations run
  at start.
- **Logs.** `docker compose logs -f kite`.
- **Queues.** Jobs are held in memory. Inbound mail is written to the volume
  before it is queued, so a restart never loses a message; at worst one
  stays unparsed until it is re-imported.

## Email assistant and MCP

Set `AI_BASE_URL`, `AI_API_KEY`, and `AI_MODEL` in the container environment to configure the built-in assistant. These values stay on the server. Assistant chat is available by default when a provider is configured; a mailbox manager can change its writing instructions and availability through the settings button in the assistant panel. Automatic reply drafts remain off until enabled there. Auto-draft work is recorded in SQLite and retried after a restart by the local scheduler. AI failure does not reject inbound mail. Out-of-office auto-replies and AI auto-drafts are separate features; turn off out-of-office replies before enabling auto-drafts for a mailbox.

The MCP endpoint is `/mcp`. Create a dedicated mailbox-scoped Bearer key in **Assistant → MCP** and give the key to a client that supports custom HTTP headers. The endpoint uses Streamable HTTP; `request_send` gives the client a review URL, and only an authenticated Kite browser session can confirm delivery. MCP read and draft tools remain available when no AI model is configured.

## Running without Docker

```bash
npm ci
npm run build:node
KITE_RUNTIME=node NODE_ENV=production DATA_DIR=./data node dist/server.mjs
```

Port 25 needs root or a capability (`setcap cap_net_bind_service=+ep`); use
`SMTP_INBOUND_PORT=2525` behind a port forward otherwise.
