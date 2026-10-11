# Assistant: automatic reading

Besides chat, drafting and MCP (see [Email assistant and MCP](email-assistant-and-mcp.md)), Kite can read new mail for you and put what it finds in front of you as suggestions. This page covers what it does, where your mail goes, what it costs and how to stop it.

## Kite reads for you

Automatic reading is a per-mailbox setting under assistant settings, **Automatic reading**. It has four autonomy levels:

| Level            | Status        | What it does                                                                  |
| ---------------- | ------------- | ----------------------------------------------------------------------------- |
| Off              | Available     | Default. Kite does not read new mail. The older auto-draft setting still works. |
| Suggest only     | Available     | Kite reads new mail and offers suggestions. Nothing happens until you accept. |
| Act with undo    | Not available yet | Reserved. You cannot select it.                                           |
| Full auto        | Not available yet | Reserved. You cannot select it.                                           |

Automatic reading also needs the email assistant to be on and the install-wide **Enable automatic reading** switch (primary admin) to be on. The settings section names the AI provider that will read the mail.

Suggestions come in these kinds when Kite finds something worth raising: a calendar invitation, a reply to review, a summary of a long thread, and a possible phishing warning. Other kinds are reserved. A suggestion expires after 14 days.

Suggestions are shown to people with full access to the mailbox only. Other users cannot tell the mailbox has any. They appear as a badge on the message row, as a card in the reader, and together on the **For you** page, grouped by kind with the most important first. Accepting or dismissing a suggestion shows a toast with Undo.

Kite never sends mail on its own at Suggest only. A reply suggestion creates a draft in the reviewer's Drafts, private to the reviewer. You review it and send it from the composer.

## Deterministic first

Most mail never reaches a model. Kite first skips messages that are not in the Inbox, come from your own addresses or from bounce senders, or are auto-submitted. For the rest it reads facts it can compute itself: sender authentication results, bulk and no-reply headers, whether the sender is a known contact, an attached calendar invite, thread length and phishing signals. It asks the model only for mail that is not bulk, automatic, no-reply or spam, from a sender you have not muted, and only when a reply, summary or phishing capability is on. Calendar invites are parsed from the attached ICS file, not by the model, and a message that needs no model costs nothing.

When Kite does call the model, the call has no tools. The model reads the message and returns a structured answer. It cannot search, send, move or delete anything. Kite checks the answer, and a reply draft is checked against the conversation so that it cannot introduce an address or link that was not already in it.

## Privacy

Message content goes to the AI provider you configured for the assistant.

- **Workers AI** (Cloudflare). The content is processed on Cloudflare, which already hosts your Kite install. It is not sent anywhere else.
- **OpenAI-compatible providers.** The content is sent to the server at the configured base URL, which is outside your install. Automatic reading with an external provider needs a separate opt-in from the primary admin (**Allow external provider for automatic reading** in the install-wide automatic reading settings). Without it, Kite skips the message and says why. Some providers may retain what you send or train on it. Read your provider's terms, or use a provider you run yourself.

What is sent: the message's sender, subject and text, the facts Kite computed and the mailbox's own instructions. Prompts and responses are not stored by Kite. It stores the suggestions and the audit log of what was done, plus token counts and cost for each request. The provider may store more under its own policy.

Message text is treated as untrusted. A message that tries to give the model orders cannot make Kite act: the model has no tools, its answer is validated, and anything that changes something needs your click at Suggest only.

## Costs and caps

Every automatic request is checked against these limits before it runs. Cheaper checks come first.

- **Deterministic filters.** The checks above run first and cost nothing. Per mailbox you can also turn off the calendar, reply, summary and phishing capabilities, and mute senders.
- **Daily limit per mailbox.** The number of messages Kite reads per UTC day. Default 200, range 1 to 1000.
- **Rate limit per mailbox.** A short burst limit. Mail over it is skipped as "rate limited".
- **Spend cap per mailbox.** An optional daily cap in USD. Empty means no per-mailbox cap.
- **Spend cap for the install.** A daily cap in USD for all mailboxes together, set by the primary admin. Default $2.00 per day.
- **When model rates are unknown.** If the model has no configured prices, Kite cannot count dollars. It then counts input tokens instead, with a cap of 2,000,000 input tokens per day for the install. Set rates for your model to get a dollar cap.

Kite reserves the estimated cost before each call and settles it with the real usage afterwards, so parallel jobs are counted against the cap before they run. Once reserved and settled spend reaches the cap, Kite starts no new calls: the message is skipped as "daily spend cap reached" and later mail is skipped until 00:00 UTC. The cap is not a guaranteed billing ceiling. Estimates are not exact, so what your provider bills can slightly exceed it.

## Kill switches

- **Install-wide.** The primary admin can turn automatic reading off for every mailbox with one switch, and can turn external providers off again at any time.
- **Per mailbox.** Set the level to Off, or use **Pause for 24 hours**. While a mailbox is paused, the settings show the end time and a **Resume** button.

When each switch takes effect differs. Kite checks the automatic-reading switch, a mailbox's Off level and pause, and the daily limit when a queued job starts. A job that has not started yet is skipped. A job that is already running may still finish its remaining model calls, such as a repair, a fallback or a reply draft. The external-provider opt-in is checked again before every model request, so turning it off also stops those remaining calls to an external provider.
- **Assistant off.** Turning the email assistant off stops all of it.

## Why Kite skipped a message

**Activity** (assistant panel) lists what Kite did and recent skipped messages with the reason in plain words:

- Automatic reading is turned off for this install, for this mailbox, or the email assistant is off.
- Kite is paused for this mailbox.
- The external AI provider is not allowed to read mail automatically.
- Daily limit reached, daily spend cap reached, or rate limited.
- The message was moved or deleted first.
- The reviewer can no longer read this mailbox.

## Activity and Undo

Every action Kite records, and every action you accept from a suggestion, is written to the action log before it takes effect, with who started it, the status and the reason. Activity shows the log for the mailbox.

Actions can be undone from Activity or from the toast for 7 days. Undo needs the same permission as the action, and undoing a sent reply or RSVP step is limited to the person who made it. An undo is itself logged as a new row.

## Calendar invites

When a message carries an invitation (ICS), the reader card shows the event and offers **Accept**, **Decline** and **Propose new time**. Kite checks your calendar for conflicts and can suggest free slots over the next 7 days.

- Replies go to the organizer named in the invitation only, never to other attendees. If the invitation names no organizer, Kite does not offer a reply.
- Accepting adds the event to your calendar and sends the RSVP. An updated invitation offers **Update event**, and a cancellation offers **Remove from calendar**.
- If Kite cannot confirm who sent the invitation (no passing DKIM or DMARC result), the card shows an **Unverified sender** warning. It also warns when the organizer's address differs from the sender's. Check both before you reply.

## Evaluating a model

`node scripts/agent/injection-eval.mjs` runs a corpus of hostile messages through the real triage and draft pipeline against a model you choose and exits non-zero on a policy breach. `node scripts/agent/fake-model-server.mjs` starts a local fake model for manual checks, which needs `AI_ALLOW_INSECURE_LOOPBACK` outside production. Neither runs in CI against a real provider.
