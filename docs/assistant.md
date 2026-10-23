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

Suggestions come in these kinds when Kite finds something worth raising: a calendar invitation, a reply to review, a summary of a long thread, a possible phishing warning, and a subscription found in a receipt or invoice (Money Watch, see [Subscriptions](#subscriptions-money-watch)). Other kinds are reserved. A suggestion expires after 14 days.

Suggestions are shown to people with full access to the mailbox only. Other users cannot tell the mailbox has any. They appear as a badge on the message row, as a card in the reader, and together on the **For you** page, grouped by kind with the most important first. Accepting or dismissing a suggestion shows a toast with Undo.

Kite never sends mail on its own at Suggest only. A reply suggestion creates a draft in the reviewer's Drafts, private to the reviewer. You review it and send it from the composer.

## Deterministic first

Most mail never reaches a model. Kite first skips messages that are not in the Inbox, come from your own addresses or from bounce senders, or are auto-submitted. For the rest it reads facts it can compute itself: sender authentication results, bulk and no-reply headers, whether the sender is a known contact, an attached calendar invite, thread length and phishing signals. It asks the model only for mail that is not bulk, automatic, no-reply or spam, from a sender you have not muted, and only when a reply, summary or phishing capability is on. Calendar invites are parsed from the attached ICS file, not by the model, and a message that needs no model costs nothing. The one exception is receipt-like mail that Money Watch could not read completely on its own: see [Subscriptions](#subscriptions-money-watch).

When Kite does call the model, the call has no tools. The model reads the message and returns a structured answer. It cannot search, send, move or delete anything. Kite checks the answer, and a reply draft is checked against the conversation so that it cannot introduce an address or link that was not already in it.

## Privacy

Message content goes to the AI provider you configured for the assistant.

- **Workers AI** (Cloudflare). The content is processed on Cloudflare, which already hosts your Kite install. It is not sent anywhere else.
- **External providers.** Anthropic receives content through its native API. Haimaker, OpenAI, OpenRouter, Groq and custom endpoints use an OpenAI-compatible API. The content is sent to the configured provider, outside your install. Automatic reading with an external provider needs a separate opt-in from the primary admin (**Allow external provider for automatic reading** in the install-wide automatic reading settings). Without it, Kite skips the message and says why. Some providers may retain what you send or train on it. Read your provider's terms, or use a provider you run yourself.

What is sent: the message's sender, subject and text, the facts Kite computed and the mailbox's own instructions. When a module asks for a few extra fields (Money Watch's vendor, amount, cycle and dates), the same request also carries that module's fixed instructions; nothing else from the message is added, and PDF text is never sent. Prompts and responses are not stored by Kite. It stores the suggestions and the audit log of what was done, plus token counts and cost for each request. The provider may store more under its own policy.

Message text is treated as untrusted. A message that tries to give the model orders cannot make Kite act: the model has no tools, its answer is validated, and anything that changes something needs your click at Suggest only.

## Costs and caps

Every automatic request is checked against these limits before it runs. Cheaper checks come first.

- **Deterministic filters.** The checks above run first and cost nothing. Per mailbox you can also turn off the calendar, reply, summary and phishing capabilities, each enabled module's own step (one switch per step, listed under the core ones), and mute senders.
- **Daily limit per mailbox.** The number of messages Kite reads per UTC day. Default 200, range 1 to 1000.
- **Rate limit per mailbox.** A short burst limit. Mail over it is skipped as "rate limited".
- **Spend cap per mailbox.** An optional daily cap in USD. Empty means no per-mailbox cap.
- **Spend cap for the install.** A daily cap in USD for all mailboxes together, set by the primary admin. Default $2.00 per day.
- **When model rates are unknown.** If the model has no configured prices, Kite cannot count dollars. It then counts input tokens instead, with a cap of 2,000,000 input tokens per day for the install. Set rates for your model to get a dollar cap.

Kite reserves the estimated cost before each call and settles it with the real usage afterwards, so parallel jobs are counted against the cap before they run. Once reserved and settled spend reaches the cap, Kite starts no new calls: the model is skipped as "daily spend cap reached" until 00:00 UTC. The cap is not a guaranteed billing ceiling. Estimates are not exact, so what your provider bills can slightly exceed it.

## Kill switches

- **Install-wide.** The primary admin can turn automatic reading off for every mailbox with one switch, and can turn external providers off again at any time.
- **Per mailbox.** Set the level to Off, or use **Pause for 24 hours**. While a mailbox is paused, the settings show the end time and a **Resume** button.
- **Assistant off.** Turning the email assistant off stops all of it.

When each switch takes effect differs. Kite checks the automatic-reading switch, a mailbox's Off level and pause, and the daily limit when a queued job starts. A job that has not started yet is skipped. A job that is already running may still finish its remaining model calls, such as a repair, a fallback or a reply draft. The external-provider opt-in is checked again before every model request, so turning it off also stops those remaining calls to an external provider.

## Why Kite skipped a message

**Activity** (assistant panel) lists what Kite did and recent skipped messages with the reason in plain words:

- Automatic reading is turned off for this install, for this mailbox, or the email assistant is off.
- Kite is paused for this mailbox.
- The external AI provider is not allowed to read mail automatically.
- Daily limit reached, daily spend cap reached, or rate limited.
- The message was moved or deleted first.
- The reviewer can no longer read this mailbox.
- A module the step needs is turned off, for example "Calendar is turned off". Kite records this with the reason code `module_disabled` and the module, skips only that step and still runs the others.

When the model is refused (the external provider is not allowed, the rate limit or a spend cap is reached), Kite still runs the module steps that need no model, such as calendar invitations and subscriptions, without the model's answer, keeps their suggestions and lists the message with the reason. The same happens when the model keeps failing on the job's last attempt ("The AI model did not answer; the message was checked without it"), or at once when Kite asked the model only because a module wanted help (that request is never retried). Only when no module step ran is the whole message skipped.

Mail a program sent (`Auto-Submitted`) is normally not read at all. When a module step opts in to such mail and is on for the reviewer and the mailbox, Kite reads it in a steps-only pass: only those steps run, no model is asked, and no summary or reply is suggested. These messages count toward the daily limit.

A module kind can be private to the reviewer: its cards, row badges and For you counts appear only for the mailbox's reviewer, and only the reviewer can accept or dismiss them. Other users with full access see nothing of it.

## Activity and Undo

Every action Kite records, and every action you accept from a suggestion, is written to the action log before it takes effect, with who started it, the status and the reason. Activity shows the log for the mailbox.

Actions can be undone from Activity or from the toast for 7 days. Undo needs the same permission as the action, and undoing a sent reply or RSVP step is limited to the person who made it. An undo is itself logged as a new row.

## Phishing warnings

A message with phishing signs gets a red warning in the reader that lists them in plain words: a link that opens a different address than it shows, failed sender checks, an attached web page that asks for a password, an attached program, a request to whitelist the sender, a match on URLhaus when the operator turned [URLhaus lookups](spam-protection.md#urlhaus-lookups-optional) on, and what the model found. The model can add reasons but never removes one Kite found itself. The warning offers **Mark as spam**, which moves the message to Spam and can be undone, **Report phishing**, which also blocks the sender and trains the spam filter harder (see [Report phishing](spam-protection.md#report-phishing)), and **Not phishing**. Reporting a message from its **More actions** menu closes its warning too.

The model's suspicion alone does not show a warning. It needs a sign in the message itself: one of the signs above, or a weaker one such as a link through a URL shortener. The model is told the authentication results, whether the sender is on one of your domains and where the links go, so an authenticated password reset or sign-in code from a service you use is normal mail to it. When the model is suspicious and the message shows no sign, Kite still writes no reply draft for it and Activity records `model_flag_unconfirmed`.

Kite also trusts some senders more. For a known contact, a sender you marked **Not phishing**, or mail from one of the install's own domains that passed DMARC without copying a contact's name, the model's suspicion is not enough even with a weak sign (Activity records `model_flag_trusted_sender`). Signs Kite found itself, such as a misleading link or a failed check, always warn, whoever the sender is.

**Not phishing** closes the warning and adds the sender to the mailbox's trusted senders. The toast offers Undo, which opens the warning again and removes the sender. There is no list of trusted senders in the settings yet.

## Calendar invites

When a message carries an invitation (ICS), the reader card shows the event and offers **Accept**, **Decline** and **Propose new time**. Kite checks your calendar for conflicts and can suggest free slots over the next 7 days.

- Replies go to the organizer named in the invitation only, never to other attendees. If the invitation names no organizer, Kite does not offer a reply.
- Accepting adds the event to your calendar and sends the RSVP. An updated invitation offers **Update event**, and a cancellation offers **Remove from calendar**.
- If Kite cannot confirm who sent the invitation (no passing DKIM or DMARC result), the card shows an **Unverified sender** warning. It also warns when the organizer's address differs from the sender's. Check both before you reply.
- Invitation handling is part of the Calendar module (see [Modules](modules.md)). A mailbox's calendar capability switch turns it off for automatic reading in that mailbox only. When the owner turns Calendar off, or restricts it for you, Kite skips the invitation step with `module_disabled`, hides invitation suggestions and their counts, and refuses to accept them or to undo an invitation action until Calendar is back on. Nothing is deleted. Proposed times use the working hours of your first enabled booking page when Booking is on, and Monday to Friday, 09:00 to 17:00 in your time zone otherwise.

## Subscriptions (Money Watch)

Money Watch is a module (see [Modules](modules.md)). It reads receipts, invoices, renewal and trial notices, refunds and failed-payment mail, including mail a program sent (`Auto-Submitted`), bulk and no-reply senders, and offers one **subscription** card per message, for example "Netflix $17.99/month, renews 1 Nov. Track it?". The card shows the amount, cycle and renewal date, the document the message is (an invoice, payment, credit note or refund), the attachment that holds it and, when the message has an `https` `List-Unsubscribe` header, the host of its cancel link.

- **Track** starts tracking the subscription, or updates the tracked one from a later invoice (a new renewal date, and "now $19.99/month, up from $17.99" when the price changed), and records the invoice or payment.
- **Record it** appears for a credit note or refund from a vendor you already track. It records the document, which lowers your paid total, and never changes the price or renewal date.
- **Mark urgent** appears when a payment for a tracked subscription failed. It flags the subscription under Needs attention and in the sidebar count.

Nothing is tracked or recorded until you click, every choice shows a toast with Undo, and undo opens the card again. Cards are private to the mailbox's reviewer: other users with full access to the mailbox do not see them, and tracked subscriptions belong to the reviewer alone. A sender without passing authentication gets the **Unverified sender** warning, and phishing or spam mail gets no card.

Each recorded document is one entry in the subscription's history on the Subscriptions page (`/finance`): its type, date, the period it covers when stated, the amount, a link to its conversation and **Open document** for the attachment. The entry points to the attachment in the message; Kite never copies it. You can also track a subscription or add a document from any message through the reader's **More actions** menu, even with automatic reading off.

Detection is deterministic first: subject, sender and body phrases, amounts, cycles and dates, the attached invoice (including the text of a plain PDF), and earlier mail from the same sender. Kite sends a message to the model for Money Watch only when it looks like a receipt and the detector left the amount, the cycle or the date empty. That request is the normal triage request with a few extra fields, under every limit above: the external-provider opt-in, the daily and rate limits and both spend caps. The model's values only fill empty fields, never override what Kite read itself and never supply the cancel link. A card marks the values the assistant read, and says "Check the amount before tracking" when the model read a different amount or currency. The cancel link comes only from the `List-Unsubscribe` header and only opens in your browser when you click **Cancel before …**; Kite never fetches it.

Each mailbox has a **Subscriptions in receipts (Money Watch)** switch in its automatic reading settings, on by default. Turning it off stops Money Watch reading that mailbox and asking the model for it.

## Assistant chat and modules

Chat offers the core email tools plus the tools of the modules that are on for you. With Money Watch on, `list_subscriptions` lists your tracked subscriptions, their renewals and the totals paid in the last 12 months, in chat and over MCP with the `mcp:finance-read` scope. The calendar tools (`get_schedule`, `search_events`, `get_event`, `create_event`, `update_events`, `delete_events`, `find_free_time`, `get_calendars`) and the calendar part of the instructions belong to the Calendar module. They follow only the Calendar module and your own module access, not a mailbox's calendar capability switch. With Calendar off for you, chat has no calendar tools.

The `open_page` tool gives you a link to a page in Kite, such as the inbox, Settings or a date in Calendar. The model can only pick from the pages that are on for you, and Kite builds the link itself, so it always points inside Kite. Nothing opens until you click the link. `open_page` exists only in chat. Automatic reading never gets tools.

## Evaluating a model

`node scripts/agent/injection-eval.mjs` runs a corpus of hostile messages through the real triage and draft pipeline against a model you choose and exits non-zero on a policy breach. `node scripts/agent/fake-model-server.mjs` starts a local fake model for manual checks, which needs `AI_ALLOW_INSECURE_LOOPBACK` outside production. Neither runs in CI against a real provider.
