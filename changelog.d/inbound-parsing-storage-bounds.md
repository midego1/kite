### Security

- Incoming mail is checked before it is parsed: a crafted message with a huge header block, thousands of MIME parts, deeply nested messages or hundreds of thousands of short lines is refused with "Message rejected: …" instead of exhausting the Worker's CPU or memory or blocking the self-hosted server. Every path that reads raw mail goes through the same bounded parser (Cloudflare, the relay, SMTP, Resend, SES, imports, JMAP `Email/import`, automatic reading), and a message that still fails to parse in the queue is dropped instead of retried (from Mailflare #214).
- Turning HTML into text for snippets, search and automatic reading no longer slows down on unclosed `<style>`, `<script>` or `<head>` tags (from Mailflare #214).
- Mail from Resend now carries its plain headers (at most 200, without any authentication or `Received` headers), so auto-replies, mailbox rules and automatic reading recognise automatic and list mail there too (from Mailflare #224).

### Changed

- A forwarded message attached inline as `message/rfc822` now shows as an `.eml` attachment instead of being merged into the body, so it is parsed only once (from Mailflare #214).

### Fixed

- A message with an oversized body, subject, address list or Message-ID is stored instead of failing and being dropped after its retries: large HTML bodies of delivered mail go to mail storage like imported ones, and the other fields are cut to fit (from Mailflare #217).
- Two first messages from the same new sender arriving at once no longer make one of them fail.
- Mail for an address that has no mailbox, alias or catch-all is refused with "No such recipient here" instead of being stored and then silently dropped. A failed routing lookup still stores the message, so nothing is lost (from Mailflare #219).
- Raw mail that nothing stores (no route, a reject rule, a forward without a copy) is deleted right away, and a daily sweep removes raw mail no message references a day after it arrived (from Mailflare #219).
