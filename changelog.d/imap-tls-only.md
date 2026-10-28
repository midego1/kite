### Security

- IMAP imports no longer connect in plain text. Turning off **Use TLS** in [Settings → Import](/settings/import) used to send the source password unencrypted on port 143; the form now offers **TLS (port 993)** or **STARTTLS (port 143)**, Kite always checks the server's certificate, and a server that offers neither is refused before any password is sent. Background jobs saved with TLS off now upgrade with STARTTLS and fail with the reason if the server cannot. Imports also only connect to ports 993 and 143.

### Added

- IMAP imports, including background jobs, now work on the Node/Docker runtime. Kite resolves the server's name itself and refuses it when any address is private; set `EXTERNAL_ACCOUNTS_ALLOW_PRIVATE_HOSTS=1` to import from a mail server on your own network (see [Self-hosting](https://github.com/midego1/kite/blob/main/docs/self-hosting.md)).
- IMAP imports sign in with `AUTHENTICATE PLAIN` when the server offers it, and fall back to `LOGIN`.
