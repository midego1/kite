# Getting help with Kite

Kite is an early-stage, community-supported open source project. There is no paid support and no response-time promise, but questions are welcome.

## Before you ask

1. Read the [deployment guide](docs/deployment.md), including the "First 10 minutes" table, and [troubleshooting](docs/troubleshooting.md). Most setup problems are a wrong `CF_TOKEN`, a Worker that is not named `kite`, or a missing `APP_URL`; the first screen of `/setup` checks all three.
2. For sending problems (spam folder, SPF, DKIM, DMARC, provider limits), read [sending and deliverability](docs/sending-and-deliverability.md).
3. Search [existing issues](https://github.com/midego1/kite/issues) and [Discussions](https://github.com/midego1/kite/discussions).

## Where to go

| You want to | Go to |
| --- | --- |
| Ask a question or get help with setup | [GitHub Discussions](https://github.com/midego1/kite/discussions), Q&A category |
| Share an idea or show your setup | [GitHub Discussions](https://github.com/midego1/kite/discussions) |
| Report a bug you can reproduce | A [bug report](https://github.com/midego1/kite/issues/new?template=bug.yml) |
| Request a feature | A [feature request](https://github.com/midego1/kite/issues/new?template=feature.yml) |
| Report a security problem | [SECURITY.md](SECURITY.md). Do not open a public issue. |
| Contribute a fix | [CONTRIBUTING.md](CONTRIBUTING.md) |

## What to include

Say how you run Kite (Cloudflare button or Docker), the version shown in the sidebar footer, which provider you use (Cloudflare, Resend or Amazon SES), and what you expected and saw. Remove tokens, API keys and real mail before pasting anything. Use `example.com` addresses.

## About Mailflare

Kite started from [Mailflare by hieunc229](https://github.com/hieunc229/mailflare) and no longer syncs with it. Problems with the original project belong in its own repository; Kite's issues and Discussions are for this version.
