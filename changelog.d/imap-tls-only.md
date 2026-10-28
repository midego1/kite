### Security

- IMAP imports no longer connect in plain text. Turning off **Use TLS** in [Settings → Import](/settings/import) used to send the source password unencrypted on port 143; the form now offers **TLS (port 993)** or **STARTTLS (port 143)**, Kite always checks the server's certificate, and a server that offers neither is refused before any password is sent. Background jobs saved with TLS off now upgrade with STARTTLS and fail with the reason if the server cannot. Imports also only connect to ports 993 and 143.
- IMAP imports limit what a source server can send (64 MB per message, 8 MB per response line, 96 MB per batch) and give every command three minutes, so a broken or hostile server can no longer fill memory or hold an import forever. Server addresses written in shorthand (such as `127.1`) are checked as the address they spell.
- The guard that keeps webhooks, alert webhooks, remote images, object stores and imports off private networks now also refuses IPv6 tunnel addresses that can carry a private IPv4 address (6to4 `2002::/16`, Teredo `2001::/32`, `64:ff9b:1::/48`).

### Added

- IMAP imports, including background jobs, now work on the Node/Docker runtime. Kite resolves the server's name itself and refuses it when any address is private; set `EXTERNAL_ACCOUNTS_ALLOW_PRIVATE_HOSTS=1` to import from a mail server on your LAN (loopback and link-local addresses stay refused), and `EXTERNAL_ACCOUNTS_EXTRA_PORTS` (for example `1143`) for a bridge such as DavMail or Proton Mail Bridge (see [Self-hosting](https://github.com/midego1/kite/blob/main/docs/self-hosting.md)).
- IMAP imports sign in with `AUTHENTICATE PLAIN` when the server offers it, and fall back to `LOGIN`.
