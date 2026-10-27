# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [calendar versions](https://calver.org/), `YYYY.MM.DD.N`: the UTC date a release was prepared and a counter for that day's releases, starting at 0 (see [Releasing](docs/releasing.md)).

## [Unreleased]

## [2026.10.27.3] - 2026-10-27

### Changed

- The inbox is now three resizable panes: the sidebar, the message list and the open email. Drag the line between two panes (or focus it and use the arrow keys) to resize them; Kite remembers the sizes per account, and dragging the sidebar narrow folds it to its icon rail, as the menu button does.
- The message list has a cleaner look: an unread dot, the sender and date, the subject and a two-line preview, with **Suspicious** and **Snoozed** badges where they apply. **All mail** and **Unread** buttons above the list replace the unread filter button, and they are there in every folder except Sent and Drafts.
- The reader's toolbar gains **Snooze** and **Move to** buttons, and a **Reply to …** box under each email starts a reply in the composer.
- Keyboard shortcuts work like Gmail's: in the list, `j` and `k` move between emails, Enter or `o` opens one, `x` selects it, `e` archives and `#` deletes it; in an open email, `j` and `k` go to the older and newer email and `a` and `f` reply to all and forward, next to the existing `r`, `e`, `#` and `u`. The Cmd+K command palette has been rebuilt and the shortcuts sheet (`?`) lists the new keys. Shortcuts can be turned off in [Settings → Inbox](/settings/inbox).
- On phones the menu opens as a sheet over the page, and an open email's toolbar stays on one line.

## [2026.10.27.2] - 2026-10-27

### Fixed

- Confirming an assistant draft's send review no longer keeps failing with "Draft changed; review it again" while the draft is open in the composer. After **Review send** stored a file you added, the composer saved the unchanged draft again a moment later, and every save counted as an edit and voided the review. A save that changes nothing about what would be sent (sender, recipients, subject, body or send time) no longer counts as an edit, the composer skips saves that would write the same content and pauses saving while a review is open. When the draft really did change after the review, the dialog now offers **Review again**, which opens a new review of the draft as it is now. **Approve to send** in the chat reviews the draft as the card shows it, including changes made in the composer since.

## [2026.10.27.1] - 2026-10-27

### Added

- **Write with Kite** in the composer (the sparkles button, or ⌘J): write an email from a short request, or rewrite the selection or the whole body shorter, longer, more formal, more casual, with spelling and grammar fixed, translated (the original stays below the translation) or as you instruct. The answer streams into a preview and enters your message only when you click Insert or Replace, with Undo afterwards; the quoted message and your signature are never sent or changed. In a reply Kite reads the email being answered from the mailbox itself. It has no tools, removes addresses and links that are not in your text or the conversation, and stores nothing but token counts and cost. It needs the assistant on and, with an external AI provider, the primary admin's opt-in, and counts against the same daily caps as chat. See [Assistant settings](/inbox) for the **Drafting and composer** instructions it uses.

### Changed

- The install-wide switch is now called **Allow an external AI provider for automatic reading and the composer** in [Admin → Agent](/agent): it also governs Write with Kite. The mailbox instruction field **Drafting** is now **Drafting and composer**, and the chat token allowance is shared with Write with Kite (**Chat and Write with Kite**).

### Fixed

- In a new message or reply the text you type no longer starts inside the signature block: the body begins with an empty line of its own above the signature.

## [2026.10.27.0] - 2026-10-27

### Added

- Editable prompts for the assistant. Under [Assistant settings](/inbox) a mailbox now has instruction fields for **Chat**, **Drafting** and **Summaries** next to its general instructions, and every user has **My instructions**, which apply in every mailbox they work in and are visible only to them. They are added to the system prompt below Kite's own rules (shown read-only under **What Kite always tells the AI**) and can never replace them; the mailbox's instructions come first. The Drafting fields also reach the reply drafts Kite writes on its own. Apply migration **0069** (`0069_add_ai_writing.sql`) from the admin overview to use them; until then only the general mailbox instructions can be saved.

### Changed

- Assistant chat now counts against the daily AI spend caps, like automatic reading: each step reserves its estimated cost against the mailbox and install caps before it is sent and is settled with its real usage, and a turn that reaches a cap ends with "Daily AI spend cap reached". Chat usage rows now carry their mailbox. Chat and automatic reading now share the install's dollar cap (default $2.00 a day), so an install that chats a lot may want to raise it in [Admin → Agent](/agent). A refused turn says which cap was reached, that it resets at 00:00 UTC and where to change it.
- Without model prices, Kite counts input tokens instead of dollars, and chat now has its own daily allowance next to automatic reading's (2,000,000 input tokens each by default, so neither can use up the other's). The primary admin can change both under **Daily token allowances without model prices** in [Admin → Agent](/agent); until migration 0069 is applied they stay at the default. Kite still ships no default model prices.

## [2026.10.26.6] - 2026-10-26

### Added

- The assistant chat can now organize more mail for you, always after you approve it in the chat: mark up to 20 emails as read or unread, list the mailbox's folders, create a folder and file up to 20 emails into one. Moves to the archive, trash or spam already covered 20 emails at once; the assistant now searches first and proposes a batch for you to approve. Every approved change shows **Undo** in the chat and appears in the assistant's **Activity** with Undo for 7 days. Creating folders and moving mail need full access to the mailbox; read state needs only read access, as in the inbox. Undo puts back only the emails still where the change left them and says how many went back; it does not reverse what the spam filter learned from a move to or out of Spam. MCP keys with **Organize mail** get the same tools (they act at once, as MCP moves always did), and **Read mail** keys can list folders.

- Design specs for AI writing (a writing style profile learned from sent mail, AI in the composer and editable per-task instructions), thread summaries (a Summarize button and optional one-line summaries in the message list), search by meaning, and the assistant by email. They are proposals for roadmap milestones 27 to 30 in `docs/specs/` and change nothing in Kite yet.

### Changed

- The README is brought up to date: it now covers Drive and object storage, lists all six modules, states the current test counts and CI setup, describes the AI assistant and **Skip DNS setup** accurately, and no longer names individual migrations.

### Fixed

- In the assistant panel, a reply draft you approved no longer shows "Preview unavailable" with **Edit draft** and **Approve to send** after it was sent. The card now says **Sent** with the subject and recipient and links to the sent message, **Scheduled for** the time it goes out, **Sending…** while delivery is still under way, or **Sending failed**, and checks again by itself with growing waits until the send finishes (also when this device's clock runs ahead of the server), keeping what it showed if a check fails. A draft that was deleted, discarded or whose send you undid says "This draft is no longer available." and offers no buttons. A finished card no longer re-checks the draft each time new mail arrives.

## [2026.10.26.5] - 2026-10-26

### Security

- A DKIM signature now verifies the sender only when it comes from the From address's own domain (or the same organization); another domain's signature alone no longer counts as authenticated. A passing DMARC check verifies the sender even when SPF failed, as for forwarded mail, and the failed SPF check still shows as a warning sign. This applies to automatic reading's trust in contacts and marked senders, the unverified-sender warning on invitations and Money Watch's unverified mark.
- Shared hosting names such as `github.io`, `myshopify.com`, `amazonaws.com` and `me.uk` count as separate owners per subdomain, for DKIM alignment and for link checks.
- SPF now reads the check of the envelope sender rather than the HELO check that Cloudflare reports first.
- Passes count only from Cloudflare's own `Authentication-Results` copy, which Kite tells apart from the sender's by comparing it with the raw message; whenever that is ambiguous, the results count as unverified, never as passed. This relies on Cloudflare adding its header to every message, as Email Routing does.
- Mail received through Amazon SES now uses the SPF, DKIM and DMARC verdicts SES reports for it, once the SNS notification's signature is verified.
- The email relay's header signature now uses a key derived from `INBOUND_WEBHOOK_SECRET`. Update the relay: the earlier signature is accepted until the first release on or after 2027-01-31 and raises a low-priority operational alert, and a request without a header signature, or with a wrong one, raises an "update the relay" alert.

## [2026.10.26.4] - 2026-10-26

### Changed

- Dropdowns, checkboxes, switches and tooltips across Kite are now built on Radix, the accessible component library behind shadcn/ui. They look as before, but a dropdown now opens a list styled like the rest of Kite (in light and dark mode) instead of the browser's own menu, and you can type to jump to an option.

## [2026.10.26.3] - 2026-10-26

### Security

- SPF, DKIM and DMARC results now count only when the server that received the message from the internet checked them. Kite trusts the topmost `Authentication-Results` header Cloudflare Email Routing adds (directly or through the email relay) and ignores every copy the sender could have written. Mail that arrives through the built-in SMTP listener, Resend or Amazon SES is treated as unverified instead of passed, so a forged header can no longer soften spam scoring, phishing warnings or automatic reading's trust in a sender.
- The email relay now signs the header map it sends with `INBOUND_WEBHOOK_SECRET`. Redeploy the relay (`deploy/cloudflare-email-relay`) after updating the server: until then mail still arrives, but its authentication counts as unverified.

## [2026.10.26.2] - 2026-10-26

### Changed

- CI: allowlist a public key-derivation label and a policy-date log value in the secret scan.

## [2026.10.26.1] - 2026-10-26

No user-visible changes.

## [2026.10.26.0] - 2026-10-26

No user-visible changes.

## [2026.10.25.0] - 2026-10-25

### Changed

- In a domain's details the **DKIM** record is now checked in the DNS checklist next to MX, SPF and DMARC instead of only under email sending, so all four records are reviewed together whichever provider sends and receives for the domain.

### Fixed

- Clicking **Setup** on a DNS record now says what is happening: a status line names the record and the domain while Cloudflare creates it and, once it finishes, whether public DNS has already verified the record or whether the change can take a few minutes to appear. The **Setup** buttons wait while a setup is running, and a failed setup shows its error in the same line.

## [2026.10.24.2] - 2026-10-24

### Security

- undici is updated to 7.30.1 and fast-uri to 3.1.9, fixing their published advisories. The AI SDK is updated to 7.0.152.

### Fixed

- When a model keeps asking for tools after the assistant reaches its step limit, the assistant still answers with the step-limit message instead of showing an error.

## [2026.10.24.1] - 2026-10-24

### Changed

- The Worker build now includes source maps, which `upload_source_maps` in `wrangler.jsonc` already requested, so errors in Workers Logs point at the original source. Build and development dependencies are updated.

## [2026.10.24.0] - 2026-10-24

### Security

- Next.js is updated to 16.4.2 and nodemailer to 10.2.1, fixing the published Next.js remote code execution and denial-of-service advisories and a nodemailer DKIM signing denial of service.
- Display names containing a backslash are now escaped correctly in sent mail (JMAP and the self-hosted mailer), and a very long malformed address header can no longer slow address parsing down.
- Readable text built from HTML mail no longer decodes `&amp;lt;` twice into `<`.

## [2026.10.23.3] - 2026-10-23

Apply database migration 0068 after deploying, from the database card on the admin overview or the banner in the mailbox. It adds the abuse.ch Auth-Key the owner can save in the app; until it is applied, a key set as a secret works as before and **Save key** asks for the update.

### Added

- The owner can enter the **abuse.ch Auth-Key** under [Admin → General](/general) → **Threat lookups** instead of setting a secret. **Save key** checks it on URLhaus and ThreatFox first and refuses a key either list rejects; when abuse.ch cannot be reached, it saves the key with a warning. The key is stored encrypted and never shown again; **Remove key** deletes it. A `URLHAUS_AUTH_KEY` or `ABUSE_CH_AUTH_KEY` secret still takes precedence, and the card says which one is in use. The card links to [auth.abuse.ch](https://auth.abuse.ch/) for a free key, which is for non-commercial use. See [Spam protection](https://github.com/midego1/kite/blob/main/docs/spam-protection.md#urlhaus-and-threatfox-lookups-optional).

## [2026.10.23.2] - 2026-10-23

Apply database migration 0067 after deploying, from the database card on the admin overview or the banner in the mailbox. It adds the Screener tables; until it is applied, every mailbox delivers as before, **Settings → Inbox → Screener** says the update is pending and Screener changes answer `503 SCREENER_UNAVAILABLE`. Mailboxes created before it is applied keep the Screener off.

### Added

- **Screener**, per mailbox: mail from someone who has never written to the mailbox before waits until you approve or deny the sender, once per address. In the default **Hold in the Screener** mode their mail stays out of the Inbox, search, counts, conversations, bulk actions, JMAP, `/api/v1` and MCP and appears under **Screener** in the sidebar with a count; in **Deliver to the Inbox** mode it arrives in the Inbox marked **New sender**. Approve and Deny are in the row and in a bar above the message in the reader. Approving releases all of the sender's waiting mail, with Undo; denying moves it to Spam, trains the spam filter and blocks the sender like Report phishing, so their later mail goes to Trash (lift it with **Un-deny**). External addresses you send to are approved automatically, and turning the Screener on offers **Approve everyone you've written to** once. Mail claiming to come from the install's own mailboxes or system addresses still needs approval: the From header alone is not proof of who sent it. Waiting mail gets no notification, automatic reply or automatic reading until it is approved; webhooks still fire. The spam filter and mailbox rules run first. It is on for new mailboxes and off for existing ones; [Settings → Inbox → Screener](/settings/inbox) turns it on or off, picks the mode and lists approved and denied senders. Only people with full access to a mailbox can change it. See [Screener](https://github.com/midego1/kite/blob/main/docs/screener.md).

## [2026.10.23.1] - 2026-10-23

One new optional secret name, `ABUSE_CH_AUTH_KEY`, another name for `URLHAUS_AUTH_KEY` (see ThreatFox lookups below).

### Added

- Optional **ThreatFox lookups**. The abuse.ch Auth-Key in `URLHAUS_AUTH_KEY` now also checks risky incoming mail against ThreatFox, abuse.ch's list of the servers, domains and files malware uses, at the same time as URLhaus and under the same rules: only mail that already looks risky, not from people you have saved or written to unless its sender checks failed, and a lookup that fails or takes over 3 seconds is skipped. ThreatFox gets only the host names of up to five links (no paths or query strings) and the SHA-256 hashes of up to three attachments. A match raises the spam score and shows on the phishing warning; when both lists match, the second adds only a little. `ABUSE_CH_AUTH_KEY` works as another name for the key. See [Spam protection](https://github.com/midego1/kite/blob/main/docs/spam-protection.md#urlhaus-and-threatfox-lookups-optional).
- **Test key** under [Admin → General](/general) → **Threat lookups**, for the owner: Kite looks up `example.com` once on URLhaus and ThreatFox and shows **Key works**, **Key rejected** or **abuse.ch unreachable** for each. The card now shows URLhaus and ThreatFox separately, and the Worker logs `spam.threat_lookup_key_rejected` when abuse.ch refuses the key, without the key or any link.
- **Trusted senders** and **Muted senders** lists in the assistant settings under **Automatic reading**, for people with full access to the mailbox: see who you marked **Not phishing** or muted, remove them, or add an address yourself. Each change is saved at once for that address only. See [Phishing warnings](https://github.com/midego1/kite/blob/main/docs/assistant.md#phishing-warnings).

## [2026.10.23.0] - 2026-10-23

### Added

- **Not phishing** on the phishing warning closes it and trusts the sender for that mailbox, so the AI model's suspicion alone no longer warns about their mail; signs Kite finds in a message itself still do. The toast offers Undo. See [Phishing warnings](https://github.com/midego1/kite/blob/main/docs/assistant.md#phishing-warnings).
- Links through URL shorteners such as bit.ly add a little to the spam score. See [Phishing signs](https://github.com/midego1/kite/blob/main/docs/spam-protection.md#phishing-signs).

### Changed

- Fewer false phishing warnings. The AI model's suspicion now shows a warning only when the message itself shows a sign of phishing, and never for an authenticated known contact or for mail from your own domains that passed DMARC; such mail still gets no reply draft. The model is now told the authentication results, the sender's domain and where the links go, so authenticated password resets and sign-in codes are treated as normal mail.
- A link that shows one address and opens a subdomain of it, or a newsletter tracking redirect to the address it shows, no longer counts as a misleading link. Links to IPv6 addresses now count like IPv4 ones, and punycode link hosts that imitate Latin letters count more than ordinary international domain names.

## [2026.10.22.1] - 2026-10-22

### Changed

- Every deploy to production is now a release with its own version number, and its GitHub release, with these notes, is published automatically after the deploy. A deploy without user-visible changes says so in its notes. See [Releasing](https://github.com/midego1/kite/blob/main/docs/releasing.md).

## [2026.10.22.0] - 2026-10-22

Apply database migrations 0062, 0063, 0064, 0065 and 0066 after deploying, from the database card on the admin overview or the banner in the mailbox. 0062 adds the module switches, per-user module access, booking appointment links and the calendar search index; until it is applied, every module stays on for everyone and search finds no calendar events. 0063 adds the Money Watch tables (tracked subscriptions and their documents); until it is applied, the Subscriptions page is empty and points to the update, and Money Watch finds and records nothing. 0064 adds the Drive tables; until it is applied, Drive says the update is pending and stores nothing. 0065 adds the object storage tables; until it is applied, everything stays in the default bucket and Admin → Storage says the update is pending. 0066 adds the domains' DNS-skipped flag; until it is applied, **Skip DNS setup** answers that the database needs an update first, everything else on the Domains page works as before and no DNS reminder is shown. Two new optional rate limit bindings, `REMOTE_IMAGE_RATE_LIMIT` (see remote images under Fixed) and `DRIVE_LINK_RATE_LIMIT` (Drive public links), which deploys that keep their own `wrangler.jsonc` can copy from `wrangler.jsonc.example`; one new optional secret, `URLHAUS_AUTH_KEY` (see URLhaus lookups below).

### Added

- After a new version of Kite is deployed, every signed-in tab shows "Kite was updated. Reload to get the latest version." with a **Reload** button and a way to dismiss it, when you come back to the tab or within five minutes. It appears once per tab, never on the first load, and compares only the version your own server reports (`GET /api/version`, signed-in users only); Kite still never checks for or downloads updates from anywhere else. See [Updating Kite](https://github.com/midego1/kite/blob/main/docs/deployment.md#updating-kite).
- **Skip DNS setup** when adding a domain, in **Admin → Domains → New domain**, in onboarding and in the first-run domain step. Kite records the domain without looking it up on Cloudflare or checking or changing any DNS, hides the provider choices and skips the MX check, so you can add a domain before its DNS is ready; mail does not arrive until the records are set. Admins who can manage domains then see a banner above the mailbox with **Review** and **Mark as done**, and the domain shows **DNS skipped** on the Domains page. With Cloudflare credentials, the first Setup on the domain page attaches the domain's Cloudflare zone, refusing a zone another account on the install already uses. `POST /api/domains` and `POST /api/v1/domains` accept `skipDns`, and `PATCH /api/domains/[id]` sets or clears `dnsSkipped`. Ported from upstream Mailflare #152. See [Skipping DNS setup](https://github.com/midego1/kite/blob/main/docs/providers.md#skipping-dns-setup).
- **Drive**, a new module for files, at [Drive](/drive). Upload files and whole folders (in 32 MiB parts, resumable for three days), create folders, preview images, video, audio, PDF and text, rename, move, search, filter by type, and use the trash, which empties itself after 30 days (Admin → Drive sets 1 to 365). **Recent**, **Shared with me** and **All attachments** (every attachment of the mail you can read, with **Open email** and **Save to Drive**) sit beside **My Drive**. Share a file or folder with people on the install who can view or edit, or create a public link at `/d/…` that always expires (up to 30 days by default, at most 365), can have a password and can be revoked; the visitor sees the install's name, never yours, and the dialog shows when a link was last opened. **Save to Drive** in a message attachment's menu copies it into a folder you choose. Admins set the storage per account (with overrides), the longest link lifetime or no public links at all, and the trash retention under Admin → Drive, which also lists everyone's usage. Drive is on by default; the owner can turn it off under Admin → Modules, which hides it and stops every public link without deleting anything. Database backups include the file names, folders, shares and links but not the file contents. Derived from upstream Mailflare. See [Drive](https://github.com/midego1/kite/blob/main/docs/drive.md).
- **Storage** under [Admin → Storage](/storage), for the owner only: keep mail, Drive files and backups in Cloudflare R2 or any S3-compatible bucket (AWS S3, Backblaze B2, Wasabi, Hetzner, MinIO and others). Each store is checked before it is saved (writing, reading, listing and deleting a test object, and the CORS rule browsers need), its keys are only ever saved encrypted with `APP_ENCRYPTION_KEY`, and endpoints on private or local addresses are refused. Choose a store per kind of data and optionally move what is already stored: the copy runs in the background with progress on the page, reads fall back to the old store until it is done, and the old copies can be deleted from the old store only afterwards. With an S3 store for Drive, or R2 S3 API keys for the default bucket (**Enable direct uploads**), browsers upload Drive files straight to the bucket in 64 MiB parts and download files of 8 MiB or more through a five-minute signed link, so large files no longer pass through Kite. Self-hosted installs can also set one store with `STORAGE_S3_*` environment variables. Every change is in the audit log. Adapted from upstream Mailflare 83ade98. See [Object storage](https://github.com/midego1/kite/blob/main/docs/deployment.md#object-storage-optional).
- **Money Watch**, a new module for subscriptions, at [Subscriptions](/finance). Automatic reading spots receipts, invoices, renewal and trial notices, refunds and failed payments (including automatic and no-reply billing mail) and offers a card such as "Netflix $17.99/month, renews 1 Nov. Track it?" to the mailbox's reviewer only. **Track** starts tracking it or updates it from a later invoice and flags price changes, **Record it** records a credit note or refund, and **Mark urgent** flags a failed payment; nothing is stored until you click, and every change can be undone (undoing **Track** is refused once a later document was recorded for the subscription, so that document is never deleted with it; remove the subscription instead). Each subscription keeps its invoices, payments, credits and refunds with links to their mail and attachments (referenced, never copied), and the page shows upcoming renewals first, monthly and yearly totals per currency and what you paid in the last 12 months. Reminders arrive before a renewal or trial end as a notice, a count on the sidebar item and, when Calendar is on, a calendar event. **Cancel before …** opens the sender's `List-Unsubscribe` link in your browser; Kite never visits it. You can also track a subscription or add a document from any message's **More actions** menu, and ask the assistant with `list_subscriptions`. When a receipt is incomplete, Kite may ask the AI model for the missing fields within the usual limits, external-provider opt-in and spend caps, and marks what the model filled. Money Watch is on by default; the owner can turn it off under Admin → Modules, and each mailbox has its own switch in the automatic reading settings. Webhook events `finance.subscription.detected` and `finance.subscription.renewal_due`. See [Assistant: automatic reading](https://github.com/midego1/kite/blob/main/docs/assistant.md#subscriptions-money-watch).
- **Report phishing**, in an open message's **More actions** menu, in the list's **Move to** and **More** menus for selected messages, and on the phishing warning. After you confirm, Kite moves the message to Spam, learns from it more strongly than from a spam report (so the next copy of the same campaign starts with a poor reputation), blocks the sender so their next mail goes to Trash, and closes the phishing warning. Saved contacts, people you have written to and addresses on your own domains are not blocked, because a phishing message can forge them; the toast says which senders were blocked and why any were not. See [Spam protection](https://github.com/midego1/kite/blob/main/docs/spam-protection.md#report-phishing).
- Optional **URLhaus lookups**. With a free abuse.ch Auth-Key in the `URLHAUS_AUTH_KEY` secret, Kite checks incoming mail that already looks risky, from senders you have not saved or written to, against URLhaus, a public list of malware sites and files: up to five links and the SHA-256 hashes of up to three attachments, never the files. A match raises the spam score and shows on the phishing warning; a lookup that fails or takes over 3 seconds is skipped. **Admin → General → Threat lookups** shows whether lookups are on. Without the secret nothing leaves your install. See [Spam protection](https://github.com/midego1/kite/blob/main/docs/spam-protection.md#urlhaus-lookups-optional).
- **Modules** under [Admin → Modules](/modules), for the owner only: turn Calendar, Booking, Email templates, Mail import, Money Watch and Drive off for everyone, or for some users under Accounts → Permissions. A module that is off disappears from navigation, the command palette, assistant chat, MCP, webhooks and search, and its pages and API answer 404. Nothing is deleted, mailbox export always works, and paused imports continue when Mail import is turned back on. Booking needs Calendar. A change reaches other open sessions within 30 seconds. See [Modules](https://github.com/midego1/kite/blob/main/docs/modules.md).
- Search finds calendar events: while you type in the search field, a dropdown lists matching events under **Events**, and choosing one opens it in Calendar. Enter still searches your mail.
- Webhook events for calendars and bookings: `calendar.event.created`, `calendar.event.updated`, `calendar.event.deleted` and `booking.appointment.created`, each with a reference to the event or appointment. They are listed and sent only while their module is on.
- The command palette has commands for Calendar (open it, go to a date, new event), Booking (open it, open an event type, copy your booking link) and Mail import, plus For you, Activity, Settings and Export. It lists only the modules that are on for you. In assistant chat, the assistant can give you a link to any of these pages.
- A **Page not found** page with a link back to the inbox, for unknown addresses and for the pages of a module that is off.
- A **Send test code** button under [Settings → Inbox → Notifications](/settings/inbox), next to **Send test notification**. It shows a sample sign-in notification with a new six-digit code and a **Copy code** button, so you can check that clicking a code notification copies the code on this device. It is available while **Show one-time codes in notifications** is on.
- CodeRabbit and Greptile review comments on open pull requests are checked automatically: a GitHub Actions workflow runs Droid in CI to verify each finding against the code, commits the ones that hold up to the pull request branch once `npm run check`, `test:coverage`, `quality:check` and `docs:check` (and, for user-visible changes, the affected e2e spec) pass with them, replies to the incorrect ones with the reason and resolves every thread it settled; a valid finding it could not fix stays open. It needs the `FACTORY_API_KEY` repository secret once, and with an optional GitHub App (`REVIEW_ADOPT_APP_CLIENT_ID`, `REVIEW_ADOPT_APP_PRIVATE_KEY`, see `docs/quality.md`) it pushes so that CI runs on the adopted commits. It is off with the `CODERABBIT_ADOPT` Actions variable set to `off`. Both reviewers follow the same rules (`.coderabbit.yaml`, `greptile.json`), and `npm run review:scoreboard` compares them by how many of their findings were adopted, so the better one can be kept.
- The assistant knows which email you have open. While an email from the selected mailbox is open, **Current email:** and its subject appear above the prompt, and "this email" in your question means that one, even after the chat has talked about others. Only the email's ID is passed to the model, with your latest message and without saving it; Kite ignores it unless the email is in the selected mailbox and visible to you. **✕** leaves the open email out until you open another one. Ported from upstream Mailflare #140.
- The installed app's icon shows how many messages are unread in your Inbox, across all mailboxes (the **All inboxes** count), in browsers that support app badges, such as an installed Kite app in Chrome, Edge or Safari. The number follows new mail and messages you read or mark unread while Kite is open, follows the new account when you switch, and is cleared when you sign out. Kite has no push notifications, so while the app is closed the badge keeps the last count it showed. Ported from upstream Mailflare #160.

### Changed

- The spam filter and the phishing warning recognise more phishing: attached web pages (HTML or SVG, especially ones presented as an invoice or document, such as `invoice.pdf.html`), attached pages that ask for a password, send a form to a website, run hidden code or redirect you, links inside attached pages, and messages that ask you to whitelist the sender or mark them as safe. Attached programs and disk images, already scored by the spam filter, now also raise the phishing warning. The warning lists each reason in plain words.
- Calendar invitations are now still detected when automatic reading's model is refused (external provider not allowed, rate limit or spend cap). The message appears in Activity with the reason, and the invitation card still shows, instead of the whole message being skipped. The same applies when the model keeps failing on the job's last attempt: Activity says "The AI model did not answer; the message was checked without it" and the invitation card still shows, instead of the job failing.
- Pull request checks finish in about half the time: the end-to-end suite runs as ten parallel shards balanced by recorded test durations (`E2E_SHARD=N/10 npm run test:e2e:shard`, durations in `e2e/timings.json`) instead of four shards split by test count, and every CI job restores a cached `node_modules` (and the E2E jobs a cached Chromium) instead of installing it. Nothing is skipped.
- The notice that the database still needs updates now sits in the empty reading pane, next to "Select a message to read", with the **Apply now** button for the owner. While a message is open, on other pages and on a phone it shrinks to a one-line banner above the mailbox.
- Snooze no longer opens a separate window. In an open message, **Snooze** in the **More actions** menu expands in place; on a list row, the clock button opens a small panel next to it. Choosing **Tomorrow**, **Next week** or **Next month** snoozes right away and shows the exact time beside each choice; a date and time of your own still needs **Snooze**.
- The Admin menu is grouped by task: **Email** (Domains, Mailboxes, Routing), **People & access** (Accounts, Modules), **Integrations** (API keys, Webhooks), **AI** (Agent, AI usage) and **System** (General, Branding, Backups, Alerts, Activity). In Settings, Security, App passwords and API keys move to their own **Security** group.
- Members who have been given permission to manage mailboxes now find **Mailboxes** under Settings → Mailbox (`/settings/mailboxes`). It lists the mailboxes they own and opens the same editor as Admin → Mailboxes, for the display name, picture, aliases, the use-all-domains option and deleting the mailbox, and it stays in Settings while doing so. Members without that permission get no entry and are sent back to Settings; the API still checks every change. Ported from upstream Mailflare #133.

### Fixed

- One-time codes in HTML-only mail whose markup is deeply indented, such as ChatGPT sign-in codes, now get the **Copy code** button and the code notification. The indentation left so many spaces between "verification code" and the code that Kite no longer saw them as belonging together.
- The MCP server now declares the tools capability, so `tools/list` always answers, with an empty list when no tool applies (for example a key whose only scope belongs to a module that is off) instead of an unknown-method error, and module tools such as `list_subscriptions` are listed with the core ones.
- One-time codes with lowercase letters, such as `b77f3a`, now get the **Copy code** button and the code notification when the code stands on its own line or right after a word like "code:". A code on its own line is also no longer lost when a street number in the footer sits near "The code will expire".
- An automatic reading job whose last attempt was stopped mid-run (for example by the Worker's CPU limit) is now marked failed with "no attempts are left" instead of being picked up again by recovery forever.
- A browser tab left open for a long time no longer keeps every message you opened in memory. Kite now remembers the 100 most recently opened messages for instant re-opening and fetches older ones again when needed.
- Files attached to a draft are kept with it. Before, they lived only in the open composer, so closing a draft and opening it again showed it without its attachments. The autosave now stores them on the draft, and sending sends each file once. A file the draft cannot keep (for example over the size limit) stays in the composer with a warning and still goes out with the message. Ported from upstream Mailflare #134.
- Typing while a new message's first autosave was still running no longer creates a second draft. Saves now run one at a time and reuse the draft the first one created, and sending or deleting waits for a save that is still running. Ported from upstream Mailflare #134.
- A scheduled send can no longer go out straight away because its time has passed. The schedule menu says "That send time has already passed. Pick a later time." for a past date and does not use it, the composer refuses a schedule that passed before you pressed **Schedule**, and `/api/send` answers 400 for a `scheduledAt` more than a minute in the past. Ported from upstream Mailflare #134.
- Text typed just before closing the composer is saved to the draft instead of being lost, and **Delete draft** no longer gets stuck after a network error or reports a failure for a draft that was already gone. Ported from upstream Mailflare #86.
- Pressing Enter or **Apply** in the **Insert link** popup no longer sends the message you are writing. Ported from upstream Mailflare #141.
- Confirming or cancelling an input method composition (for example Japanese or Chinese typing) with Enter or Escape in the **Insert link** popup no longer applies a half-typed address, closes the popup or leaves the composer.
- In conversation view, a conversation row is bold only when a message it stands for in that folder is unread, so an unread archived reply no longer makes the Inbox row look unread and a sent reply is never bold. Marking a conversation read or unread moves the sidebar Inbox count by the number of messages it really changes, and only from the Inbox, and opening an unread message in another folder no longer lowers it. **Delete forever** on a message that has meanwhile left Trash or Spam now says "Some messages could not be deleted because they are no longer in Trash or Spam." and keeps the message open instead of going back to the list as if it had worked; for a selection the progress toast says so. Ported from upstream Mailflare #135.
- For a domain whose DNS is managed outside Cloudflare, the Resend and Amazon SES receiving steps now look the MX record up in public DNS, so "MX record points to Resend" (or SES) passes once the record is published instead of always failing; when the lookup itself fails the step says "Could not check DNS from here". The DNS check on the Domains page now checks DKIM at `resend._domainkey` for a domain that sends through Resend instead of leaving it unknown. Ported from upstream Mailflare #132.
- Message lists can be used with the keyboard. Tab now reaches each message (in the wide layout it used to skip from the checkbox and star straight to the next row) and Enter opens it; a click anywhere on the row still opens it. The focused row has a visible ring, rows are announced as a list with "Unread" before unread senders, the open message is marked as current, each checkbox is named after its sender or draft subject, and the star button keeps one name, **Star**, and reports whether it is on. A **Skip to main content** link is the first Tab stop on every signed-in page. Ported from upstream Mailflare #91.
- Dialogs, menus and the composer handle keyboard focus. The command palette and the keyboard shortcuts help are announced as dialogs, take focus when they open, keep Tab inside and give focus back to where it was when they close; the palette's results are a list whose highlighted command screen readers follow, and the help closes on Escape or `?`. Escape closes the account menu and a conversation message's **More actions** menu and leaves focus on their button, and tabbing out of them closes them. A new message starts in the **To** field and an opened draft or reply in the body, closing the composer returns focus to the button that opened it, and the popup composer is a labelled region. Activating a button with a tooltip no longer drops keyboard focus, Escape hides a tooltip, and one-key shortcuts no longer fire while focus is in a dialog, menu or list box. Ported from upstream Mailflare #92.
- Errors and status messages are announced. Error lines in sign-in, settings, admin, contacts, templates and message actions are alerts and save results such as **Saved** or **Password changed** are status messages, so a screen reader reads them when they appear; a failed sign-in is also tied to the email and password fields, which are marked invalid. The composer's confirmation is a status message and its errors are alerts, a new-mail notification is read out, and the startup screen says "Loading" only while it shows, with a decorative logo. Controls that had no name got one: the open-booking-page link (formerly a link inside a button), the backup file picker, the AWS and Resend key fields, the two-factor QR code and the composer's quoted-text button. The bulk **Move to** button is named by its visible text, and the profile, forwarding and sign-up fields carry `autocomplete` hints. Ported from upstream Mailflare #93.
- Every page has a title, one main heading and named navigation. Settings, Admin, Calendar, Bookings, Subscriptions, Compose, For you and Activity pages set the tab title to "<page> - <app name>", also after moving between pages without a reload, so the screen reader's page announcement is right; the sign-in, forgot-password and reset-password pages have their own titles. Mail folders always have a level-one heading with the folder name (a level-two one while a message is open), the Settings and Admin menu title is no longer a second level-one heading, and Calendar, My account, Inbox settings, Rules & routing, Export and Import get a heading for screen readers. The sidebar navigation is named after the app. Ported from upstream Mailflare #94.
- Secondary text is easier to read. Captions, timestamps, helper lines, key hints, chart labels and empty-state lines that were light grey now use the darker grey, which itself is a little darker in the light theme (#6b6b6b, 5:1 on the page background) and lighter in the dark theme, along with the close and remove buttons in the composer, the new-mail notification, the shortcuts help and the routing info hints. The highlighted command in the command palette keeps white text in every theme, and the green success badge uses a darker green. Placeholders, disabled text, decorative icons and form borders are unchanged. Ported from upstream Mailflare #95.
- More keyboard and screen reader fixes. In the mobile layout Escape closes the menu drawer and puts focus back on the menu button. The calendar event editor is a proper modal: focus moves into it, Tab stays inside, Escape closes it (not while a save is running) and focus returns to where it was. The info icons next to the routing options are buttons, so the hint is reachable by keyboard and announced. Table column headers on Activity, AI usage, Webhooks deliveries and account permissions declare `scope="col"`, the empty actions header on deliveries has a hidden label, and the wide tables on Activity, AI usage and Webhooks deliveries can be scrolled with the keyboard. Cloud attachment links in a message announce that they open a new tab. Ported from upstream Mailflare #131.
- JMAP mail apps that list optional IETF extensions they never call, such as Flectar Mail with `urn:ietf:params:jmap:vacationresponse`, can sync again. Kite ignores an unimplemented `urn:ietf:params:jmap:*` capability in `using` instead of refusing every request with `unknownCapability`; that extension's methods still answer `unknownMethod`, and capabilities outside that namespace are still refused. Ported from upstream Mailflare #155.
- JMAP `Email/get` and `Thread/get` answer up to 200 ids again for keys that can read many mailboxes. Kite now binds the mailbox list as one value, so the request no longer runs over the database's limit of 100 values per query and fails with `serverFail`; mailbox counts and folders for such keys are read in batches too. A repeated id is listed once, in `list` or in `notFound`, instead of twice when its copies fell into different batches, and a `serverFail` no longer shows the failed query and its values to the client. Ported from upstream Mailflare #157.
- JMAP apps that follow the standard can move messages and change flags again. `Email/set` patch keys are JSON Pointers, so the `~` in a mailbox id such as `mbx_…~trash` arrives escaped as `~0`; Kite did not decode it, refused every move with "A message belongs to exactly one mailbox" and ignored escaped keyword changes. Ported from upstream Mailflare #162.
- Keyboard shortcuts leave browser and system key combinations alone. A key pressed with Cmd or Ctrl (or with Alt, unless Alt types a symbol) no longer counts as the first key of a shortcut such as `g i`, so Cmd+G followed by `i` stays on the page, and Cmd+? or Ctrl+/ no longer opens the shortcuts help or the search field instead of reaching the browser. Cmd+C, Cmd+R and Cmd+F were already left to the browser. `?`, `#` and `g !` typed with Shift still work, and so do `#` and `/` typed with AltGr or Option on keyboards that need it, such as `#` on French AZERTY or a British Mac. Ported from upstream Mailflare #161.
- Remote images whose host allows only its own site to show them (`Cross-Origin-Resource-Policy: same-origin`) no longer stay broken after **Show images** or with **Always show remote images** on. The reader now loads the remote images it shows from Kite's own address, `/api/remote-images`, which fetches only an image that a message you can open names, only from a public host over https, only PNG, JPEG, GIF, WebP or AVIF up to 5 MiB, and sends the image host neither your IP address, your cookies nor the page you were on. As before, nothing loads until you allow remote images. The self-hosted Node/Docker server does not proxy them and the browser keeps loading them directly. Ported from upstream Mailflare #148.
- The fixes below were ported from upstream Mailflare by hieunc229 (AGPL-3.0):
  - Replying to a message sent from the mailbox's own address (for example a copy of your own mail, or mail from an alias) now addresses that sender instead of leaving the recipient empty with "Sender address is required" ([mailflare#145](https://github.com/hieunc229/mailflare/pull/145)).
  - The assistant's email address parameters (`draft_email`'s `to` and calendar attendees) are now described to the model as strings with an `email` format and no regex `pattern`, so providers such as OpenRouter, which reject regex lookarounds in tool schemas, no longer refuse every assistant request; the address is still checked when the tool runs ([mailflare#117](https://github.com/hieunc229/mailflare/pull/117)).
  - With Workers AI, streamed assistant replies no longer show each text chunk and tool call twice; Kite drops the duplicate copy the provider adds to every streamed chunk ([mailflare#120](https://github.com/hieunc229/mailflare/pull/120)).
  - The assistant's `list_emails` tool accepts a missing or `null` cursor for the first page, and an unknown cursor answers "Invalid pagination cursor" with how to start over instead of "Message not found" ([mailflare#144](https://github.com/hieunc229/mailflare/pull/144)).
  - A list action that fails (archive, trash, move, star, mark read, unsnooze, a swipe, or the same on a selection) now shows "Could not update the messages. Please try again." and puts the messages back, instead of failing silently ([mailflare#88](https://github.com/hieunc229/mailflare/pull/88)).
  - Two-key shortcuts work after a stray key (`q g t` still goes to Sent) and when the second key needs Shift (`g !` goes to Spam); pressing Shift on its own no longer breaks the sequence ([mailflare#89](https://github.com/hieunc229/mailflare/pull/89)).
  - **Move to → Inbox** on snoozed mail now ends the snooze, so the message shows in the inbox, and a custom folder's **Move to** menu offers **Inbox** again; the inbox no longer offers moving to itself ([mailflare#90](https://github.com/hieunc229/mailflare/pull/90)).
  - On a phone, the message reader, conversation and one-time code card use narrow side margins, so the subject and body are no longer squeezed by desktop indents ([mailflare#112](https://github.com/hieunc229/mailflare/pull/112)).
  - The routing rule switches and buttons under Admin → Routing are announced with the rule they belong to ("Enable rule: …", "Edit rule: …", "Delete rule: …"), and the keep-a-copy switch has a label ([mailflare#129](https://github.com/hieunc229/mailflare/pull/129)).
  - The browser tab shows your custom app name from Admin → Branding from the first page load instead of "Kite" until the page finishes loading, and leaving a mail folder no longer leaves its title on the next page ([mailflare#81](https://github.com/hieunc229/mailflare/pull/81)).
- The development server (`npm run dev`, and the e2e suite that runs on it) no longer refuses file uploads over 1 MB, such as draft attachments, avatars and backup restores, with "Payload Too Large". Deployed Workers were not affected.

### Security

- Email HTML is sanitized with an allowlist twice. Received mail (delivery, mail import and JMAP `Email/import`) is cleaned before it is stored, so the API, JMAP, webhooks and exports never hand out scripts, event handlers, frames, forms or script links; layout, classes and images stay, and the raw message keeps the original. Mail stored before this release is unchanged. The reader, reply and forward quotes, signatures and drafts opened in the composer now go through DOMPurify with the same allowlist as before, on top of the sandboxed frame. Drafts written by another mailbox member, over JMAP or by the assistant are cleaned before the composer shows them.
- Attachments open in the browser only when their type cannot run script: PDF, plain text, CSV, JSON, common images (PNG, JPEG, GIF, WebP, AVIF, BMP), audio and video. Everything else, including HTML, SVG and XML, downloads even when the sender marked it inline, and Kite sends back only the parsed type instead of the sender's raw `Content-Type`, so a value such as `image/png, text/html` can no longer slip through. Shared attachment links do the same. Ported from upstream Mailflare (hieunc229/mailflare#103).
- Domain routing rules (Admin → Routing and the domain section of Settings → Rules) now need the domain-management permission, like the Domains page. Before, any admin with mailbox management could change the primary admin's domain rules while an admin granted domain management could not, and a member who manages a mailbox could edit or delete a domain rule that delivers to it through the inbox-rule API. The Routing item in the Admin menu is shown only to admins who can manage domains. Ported from upstream Mailflare (hieunc229/mailflare#147).

## [2026.10.13.0] - 2026-10-13

No database migrations and no new settings or bindings.

### Fixed

- **Send test notification** under [Settings → Inbox → Notifications](/settings/inbox) shows a banner on every click. A second click while the previous test was still in the notification centre used to replace it silently, so nothing seemed to happen.

## [2026.10.12.1] - 2026-10-12

No database migrations and no new settings or bindings.

### Added

- A **Send test notification** button under [Settings → Inbox → Notifications](/settings/inbox). It shows a sample browser notification right away, so you can check that notifications reach this device before relying on them for new mail.
- Release notes can link straight to a setting: a link to an app page (such as `/settings/inbox`) in `CHANGELOG.md` opens that page from the **What's new in Kite** dialog.
- Roadmap: the Drive and storage milestone gains **Your own database** — a self-hosted install can run a hosted SQLite-compatible database (libSQL or Turso) behind the existing database seam, with D1 and the SQLite file unchanged — and the storage-provider list names RustFS next to MinIO.

### Changed

- Pull request checks finish faster: the end-to-end suite now runs as four parallel shards (`PLAYWRIGHT_SHARD=N/4`), each with its own dev server and database, next to the Mission validation and Node build jobs. Nothing is skipped; the longest spec file (`23-auto-agent`) is marked parallel so it spreads across shards.

## [2026.10.12.0] - 2026-10-12

No database migrations. New defaults to know: a per-user sending allowance of 100 messages an hour and 500 a day is on by default (`SEND_LIMIT_PER_HOUR`, `SEND_LIMIT_PER_DAY`).

### Added

- Haimaker.ai is the first AI provider option, with a live model catalog and the **Refer & Earn** code and sign-up link. Anthropic is also available through its native Messages API, with models loaded from Anthropic's API. Chinese model families in Haimaker's catalog, including DeepSeek, Qwen, GLM, Kimi and MiniMax, remain dynamically listed rather than hardcoded.
- One-time codes (sign-in, verification, 2FA) detected in new mail can be copied in one click: the browser notification leads with the code, shows a **Copy code** action where the browser supports actions and copies on a plain click elsewhere (a minimal `kite-sw.js` service worker is registered when notifications are enabled), the in-app new-mail popup and the message reader show the code with a **Copy code** button, and a clipboard that refuses an automatic copy falls back to a dialog with one more Copy. Settings → Inbox → Browser notifications has a per-browser switch to keep codes out of notifications. Codes are detected at delivery with conservative heuristics (English and Dutch), sent only to users who can access the mailbox, never stored in a column and never logged.
- The sidebar footer shows when this build was made ("Updated 12 Oct, 14:20", in your locale and time zone). Clicking it opens **What's new in Kite**, which renders the release notes bundled with the release.
- A banner in the mailbox when the deployed version is ahead of the database schema. It says how many database updates are waiting, warns that new email may not appear until they are applied, and lets the primary admin apply them without leaving the mailbox; everyone else is told to ask an administrator. Set `AUTO_APPLY_MIGRATIONS=1` to apply them automatically instead (see [Deployment](https://github.com/midego1/kite/blob/main/docs/deployment.md)).
- A queue message that fails while database updates are pending now waits longer before its next attempt, so applying them within that window still keeps the mail.
- A per-user sending allowance: 100 messages an hour and 500 a day by default, counted from `outbound_jobs`, answered with HTTP 429 when reached. Change or turn it off with `SEND_LIMIT_PER_HOUR` and `SEND_LIMIT_PER_DAY`. No database migration.
- The first-run setup check now validates `APP_ENCRYPTION_KEY`, `APP_URL`, the Worker name and `CF_TOKEN` (a live call to Cloudflare), refusing to continue on a missing or example encryption key or a rejected token and showing the rest as recommendations. `APP_ENCRYPTION_KEY` is now prompted for by the Deploy to Cloudflare button.
- `docs/sending-and-deliverability.md`: who can send, why Kite is not an open relay, the limits, and SPF, DKIM and DMARC for Cloudflare, Resend and Amazon SES.
- README: why Kite, a comparison with Cloudflare Email Routing alone and hosted inboxes, known limitations, a demo recording and a note on how Kite was built. A feature-request issue template, issue chooser links to Discussions, `SUPPORT.md`, a 1280x640 social preview image and `npm run demo:record` / `npm run social:preview`.

### Changed

- A password reset link is sent at most once a minute per account.

### Fixed

- Manual backups no longer stay "RUNNING" forever. A manual backup is queued and exported by the outbound queue consumer instead of running inside the admin request, where a ~50 MB database outlived the response timeout and the cancelled invocation left the row unfinished with no file and no way to delete it. A backup left queued or running for over 30 minutes is marked failed with "Backup was interrupted before it finished" by the five-minute cron and when the Backups page loads, and an interrupted backup can be deleted.
- Settings > App passwords can create app passwords again. The form now asks which mailboxes the app may use (all of them by default, up to 30) and sends them, and a refused request shows the server's reason instead of "Could not create a key".
- Saving AWS credentials that work but lack SES permissions now shows the missing permissions and the IAM policy to attach under the error, while the form is still open. The refusal now carries the policy, and the Domains page keeps the response body of a failed request.

## [2026.10.09.1] - 2026-10-09

No database migrations. Deploys that keep their own `wrangler.jsonc` need the new `BOOKING_RATE_LIMIT` rate limit binding from `wrangler.jsonc.example`.

### Added

- Roadmap milestone for Drive and storage: other S3-compatible stores, an optional Drive, automatic cold storage and external storage.

### Changed

- Patch and minor dependency updates, including the MCP server SDK 2.3.1, drizzle-orm 0.45.4, Tailwind CSS 4.3.3 and Vite 8.3.4.

### Fixed

- Opening a message while others are checked shows it in the reading pane and clears the selection, instead of keeping the selection pane in its place.

### Security

- Adding or removing a mailbox alias needs admin rights or the **Manage mailboxes** permission, and an alias can no longer take an address that already delivers to another mailbox (including use-all-domains addresses and dot or `+tag` variants).
- Domain routing rules can only be read and changed by an admin of the domain. Other users see a note under Settings → Rules and keep their own inbox rules.
- Regular-expression routing rules refuse nested repetition such as `(a+)+`, backreferences and patterns over 200 characters, the most common causes of runaway matching.
- JMAP `Email/set` needs full access to change or delete mail; delegates with send permissions can still edit and discard their own drafts. JMAP `Mailbox/set` needs full access to rename a folder and only touches folders that belong to the named mailbox.
- Public booking requests are limited to 5 per minute per IP (`BOOKING_RATE_LIMIT`).
- Dependencies with known vulnerabilities were updated (Wrangler, the Cloudflare Vite plugin, workerd, sharp, undici, brace-expansion and fflate). The remaining `npm audit` findings are in build and development tools only.

## [2026.10.09.0] - 2026-10-09

The first release of Kite. It started from [Mailflare by hieunc229](https://github.com/hieunc229/mailflare); the entries below describe what changed since then.

### Added

- The Kite name and logo, the Kite style (indigo and lavender, Manrope, Ms Madi script accents) as the default, and a Classic style under Settings → Inbox → Appearance.
- Optional preview before sending and configurable undo send.
- Reading pane beside or below the list, or full width, with three densities, chosen from the account menu.
- Undo for archive and trash, and a shared confirm dialog for destructive actions.
- IMAP imports run as background jobs.
- Personal **Max steps per question** setting for the email assistant (default 15, 3 to 30); the last step always produces an answer instead of another tool call.
- `count_emails` assistant and MCP tool that answers "how many" questions with one count.
- Webhook channel for operational alerts (Slack, Discord, ntfy or generic JSON), set up under Admin → Alerts with a **Send test alert** button. Email and webhook are tried independently with a timeout and one retry, so an alert still arrives when email sending is down.
- Banner on the dashboard for every admin while an operational alert is active, dismissable until the set of alerts changes.
- Worker Previews configuration, so a branch can be tried on its own address before it reaches `main` (see "Try a branch before it goes live" in `docs/deployment.md`).
- Redacted structured logs, request correlation and a relay health endpoint. Queue and inbound failures keep non-PII context; requests are logged only on errors, client errors and slow responses.
- Calendar versions (`YYYY.MM.DD.N`) from `VERSION`, shown with the commit in the sidebar and the database card and reported by MCP and the OpenAPI document. `npm run release:prepare` prepares a release.
- Contributing guide, security policy, code of conduct, roadmap, operator runbooks and this changelog.
- Playwright browser tests against an isolated local database, unit tests, coverage gates, quality checks (complexity, size, unused code, duplicates, import boundaries, bundle budgets), a reproducible development container and an optional pre-commit hook.
- Continuous integration, Gitleaks and Semgrep scans, an advisory pull request report, CodeRabbit review configuration and Dependabot updates.

### Changed

- Every feature is available without a license key; licensing and self-update were removed.
- Backups stream to R2 in parts, so large databases back up within Worker memory limits. A backup runs automatically before every migration and restore.
- Restores are validated first and roll back to the safety backup on failure.
- Folders open without a loading delay, and cached lists show on the first frame.
- Resizing the message list follows the mouse without lag.
- Message lists use indexes and cursor paging; large lookups are chunked under D1's parameter limit.
- MCP lists only the tools a key's scopes allow.
- The app is formatted with Prettier, type errors fail the Next.js build, and `noImplicitAny` is enabled.

### Security

- Sessions live only in an `HttpOnly` cookie, with central CSRF checks and a nonce-based Content Security Policy.
- Email HTML renders in a sandboxed frame without scripts; remote images are blocked until allowed.
- Provider keys and IMAP passwords are encrypted at rest with `APP_ENCRYPTION_KEY`.
- The alert webhook URL is encrypted at rest and never shown again after saving. It must use `https` and a public host, and is checked again before every send; `ALERT_WEBHOOK_ALLOW_INSECURE` allows `http` to loopback in development only.
- First-run setup in production refuses the example `SETUP_TOKEN` and tokens shorter than 16 characters, so a deploy that keeps the Deploy to Cloudflare default cannot be claimed by someone else.

### Fixed

- Starring a message from a conversation thread shows the correct state.
- Bulk actions, Clear selection and Empty Trash/Spam return to the folder list instead of re-opening the message that was open behind the selection, and a message that leaves the list no longer stays selected.
- Icon-sized buttons get their intended size.
- In dark mode, plain emails are shown in full on the page background.
- Cloudflare authentication errors explain how to verify an Account API token as well as a user token.
