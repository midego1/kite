### Security

- Incoming mail is checked before it is parsed: a crafted message with a huge header block, thousands of MIME parts, deep nesting or hundreds of thousands of short lines (in a body, a text attachment or an attached message) is refused with "Message rejected: …" instead of exhausting the Worker's CPU or memory or blocking the self-hosted server. Every path that reads raw mail goes through the same bounded parser (Cloudflare, the relay, SMTP, Resend, SES, imports, JMAP `Email/import`, automatic reading), and a message over the limits that still reaches the queue is dropped instead of retried; any other parse error is retried as before (from Mailflare #214).
- Turning HTML into text for snippets, search and automatic reading no longer slows down on unclosed `<style>`, `<script>` or `<head>` tags (from Mailflare #214).
- A plain-text message in `format=flowed` is unfolded in linear time: a 2.4 MB message of 39,000 flowed lines took about 25 seconds to parse and now takes well under one.
- Mail from Resend now carries its plain headers (at most 200, without any authentication or `Received` headers), so auto-replies, mailbox rules and automatic reading recognise automatic and list mail there too (from Mailflare #224).

### Changed

- A forwarded message attached inline as `message/rfc822`, and each post of a digest, now shows as an `.eml` attachment instead of being merged into the body, so it is parsed only once. Attached messages do not count toward the limit of 10 attachments (from Mailflare #214).
- After upgrading, the daily raw mail sweep (02:00 UTC) works through the existing `inbound/` folder of the Mail store, up to 20,000 objects a day, and deletes raw mail older than a week that no message refers to. Raw mail of stored messages is never touched (see "Inbound mail limits" in `docs/operations.md`).

### Fixed

- A message with an oversized body, subject, address list or Message-ID is stored instead of failing and being dropped after its retries: large HTML bodies of delivered mail go to mail storage like imported ones, and the other fields are cut to fit (from Mailflare #217).
- Two first messages from the same new sender arriving at once no longer make one of them fail.
- Mail for an address that has no mailbox, alias or catch-all is refused with "No such recipient here" instead of being stored and then silently dropped. A failed routing lookup still stores the message, so nothing is lost (from Mailflare #219).
- Raw mail that nothing stores (no route, a reject rule) is deleted right away, and a daily sweep removes raw mail no message references a week after it arrived (from Mailflare #219). A message whose forward failed under a forward rule without a copy goes to the rule's mailbox, or is kept in mail storage and logged, instead of being dropped.
- When the routing lookup fails (the database is unavailable), mail is now stored for the queue even with account forwarding set up, instead of being refused with "Processing failed".
