# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [calendar versions](https://calver.org/), `YYYY.MM.DD.N`: the UTC date a release was prepared and a counter for that day's releases, starting at 0 (see [Releasing](docs/releasing.md)).

## [Unreleased]

## [2026.11.01.0] - 2026-11-01

### Changed

- The command center in the empty reading pane now looks like the rest of Kite: the sidebar's small grey group labels ("Right now", "Accounts", "Needs attention", "Quick actions", "Today", "Money Watch") over plain rows with the sidebar's icons and hover, the same notices the [Admin overview](/admin) shows under **Needs attention**, and no cards, pills, tiles or glow of its own. The greeting ("Good morning," and so on) now shows in every style, small and muted above your name in Kite and Classic; Kite classic keeps its handwritten script. The small kite in the corner stays, without its glow. No migration.

### Fixed

- The message list always scrolls inside its own panel: a folder with more mail than fits the window no longer grows the page past the bottom of the list and reader panels.

## [2026.10.31.11] - 2026-10-31

### Changed

- The recovery runbook now has one section for rolling back and restoring backups across attachment sharing and raw-backed attachments: what each older release can read, the materialize procedure before a rollback, and what to expect after restoring an older or newer backup (choose **Reclaim space** after restoring a backup taken before a reclaim). See [Attachment storage: rollbacks and restores](https://github.com/midego1/kite/blob/main/docs/runbooks/recovery.md#attachment-storage-rollbacks-and-restores).

### Fixed

- Files in received or imported mail no longer stay missing after an older Kite release restored a newer backup into a database without migration 0088. Once the migration is applied, the next time such a file is opened Kite finds it in the stored raw message again, and **Restore separate copies** under [Admin → Storage](/storage) now includes these files too. No migration or setting is needed.
- **Why?** for failed AI requests on the [Admin overview](/admin) no longer says Ask AI "would fail the same way" once you have saved the AI provider in use (a new key or model) or switched to another one in [Admin → Agent](/agent#ai-provider): failures from before that change no longer count. When Kite cannot read the provider settings, Why? still lists the failures and only Ask AI is marked unavailable.
- A question **Ask AI** prepared for the assistant is dropped after five minutes if the assistant never took it, so it no longer turns up in a chat opened much later. Closing the Why? dialog returns the keyboard focus to **Why?**.
- The command center in the empty reading pane: the hint under the cards and the grey details on the cards now reach WCAG AA contrast in every style and theme, links on its cards keep a faint underline in the Kite style (where they are the same colour as the text), and information notices under **Needs attention** use a calmer blue wash in Classic light. No migration.

## [2026.10.31.10] - 2026-10-31

### Added

- [Admin → Storage](/storage) has an **Attachment storage** card for the primary admin: how many files have a copy of their own, how many are served from their raw message, how many share a copy with a forward or a sent message, and how much space older mail could free. **Reclaim space** serves older received and imported files from their raw message when their bytes match and deletes the separate copies nobody else uses; **Restore separate copies** gives every file its own copy again. Both run in the background, show their progress, can be stopped and resume where they left off. Every file downloads byte for byte the same before and after. Needs migration 0090 (`0090_add_attachment_storage_job`), applied from the Admin overview; Reclaim space is unavailable while `ATTACHMENT_RAW_INDEX=off`.

### Changed

- Rolling back to a release before 2026.10.31.3, or before attachment sharing, now has one procedure: set `ATTACHMENT_SHARING=off` and `ATTACHMENT_RAW_INDEX=off`, deploy, choose **Restore separate copies** and wait until it reports no files served from the raw message and no shared copies, then roll back. See [Materialize, then roll back](https://github.com/midego1/kite/blob/main/docs/runbooks/recovery.md#materialize-then-roll-back).

### Fixed

- **Ask AI** for failed AI requests on the [Admin overview](/admin) no longer leaves out cut-off failures on a busy day. The notes on what a feature asks the model for now come only with cut-off failures, where they explain the output cap, instead of with the first group that names the feature. The summary keeps whole groups: one that does not fit is counted in a closing line instead of being cut off half-way, and a later group may take its place. No migration.

## [2026.10.31.9] - 2026-10-31

### Added

- **Why?** next to "N AI requests failed in the last 24 hours" on the [Admin overview](/admin) and in the mailbox's command center (primary admin): the failures grouped by cause, each with the features, provider and model, how often and when, the likely cause and a link to the setting that fixes it, worked out by Kite without asking an AI. **Ask AI** in it opens the assistant with that summary (codes and counts, no email) ready to send, and says why when the assistant can't answer either. No migration.

### Changed

- Files in received and imported mail are no longer stored a second time: when Kite can verify a file's bytes inside the stored raw message, it is served from exactly that part of the message, so a message with attachments takes about a third less storage. Downloads, previews, inline images, large-attachment links, JMAP, Save to Drive, forwarding and sending return the same bytes as before, and "Show original" is unchanged. Files Kite cannot verify there (quoted-printable, uuencode) keep a copy of their own, and a file whose stored copy has gone missing, for example after restoring an older backup, is rebuilt from the raw message the next time it is opened. No migration is needed; while migration 0088 is still pending, new mail keeps storing copies. The new environment variable `ATTACHMENT_RAW_INDEX=off` makes new mail store a copy of each file again; it is on by default.
- **Do not roll back to a release before 2026.10.31.3 once this one has run**: those releases cannot open files served from the raw message and show them as missing. Fix forward instead, or follow the [recovery runbook](https://github.com/midego1/kite/blob/main/docs/runbooks/recovery.md#rolling-back-past-raw-backed-attachments) first. The earlier warning about rolling back past attachment sharing still applies.
- **Why?** for cut-off failures on the [Admin overview](/admin) now states what Kite knows: the feature's output cap and how it is made up, whether thinking was on and at which effort, the tokens used, whether Kite already retried, and the setting to change. **Ask AI** sends the same facts with Kite's diagnosis and a note on what the feature asks the model for, so the assistant can answer for Kite instead of guessing. Still no email content.
- The command center in the empty reading pane now sits calmly in every style and theme: its cards are quiet raised surfaces with a hairline edge and a faint glow of the style's accent, the counts are plain pills with a coloured dot, the quick actions match them, and a warning under **Needs attention** (or a waiting database update) is one amber callout that reads well on dark and light surfaces alike, instead of the solid blue and brown blocks Kite classic showed in dark mode.
- The switch is now called **Allow an external AI provider to read mail** in [Admin → Agent](/agent), and its description lists every feature it covers.
- With an external AI provider that the primary admin has not allowed to read mail (**Allow an external AI provider to read mail** in [Admin → Agent](/agent#automatic-reading)), the older **Automatically draft replies** setting no longer queues a draft for every new message only to skip it, so Activity is not filled with skipped drafts. The Privacy section of the assistant guide now also says that a custom endpoint you run yourself counts as external and needs the opt-in.
- Reloading after an update no longer shows the kite's return: the page reloads like an ordinary refresh. The startup screen could stop responding on that load only, and this keeps it out of the way while the cause is found. The kite still flies off before the reload.

### Fixed

- Automatic reading with Anthropic's Claude Haiku 5.5 (and other Claude 5 models) no longer fails with "The AI's answer was cut off" (`cut_off`). These models think by default, and thinking counts against automatic reading's 400-token answer budget, so the budget was spent thinking. Kite now switches thinking off for automatic requests, agent drafts, summaries, one-line summaries and Write with Kite unless a reasoning effort is saved for the model in [Admin → Agent](/agent); Claude Sonnet 5.5 gets its lowest setting, and a model that always thinks (Claude Opus 5.5, Fable) gets effort low with room to think. A cut-off answer is asked once more with double the budget before it fails. Agent reply suggestions with Anthropic also get these settings now. No migration.
- A start whose page stops responding behind the loading screen (bar frozen, kite still swinging, no **Reload Kite**) now says so: after 10 seconds without a sign of life the screen shows "Kite stopped responding. Reload this page to start again." It is drawn by CSS alone, so it appears even when no script can run.
- When a page froze while starting, the next load reports to the server how far it got and which part of the app was rendering last (`boot.previous_load_froze` in the Worker logs), with no message content or addresses, so the cause can be found without copying details by hand.

### Security

- The primary admin's external-provider opt-in now also covers the assistant chat and the older **Automatically draft replies** setting, as it already did for automatic reading, Write with Kite and summaries. With an external provider (anything but Workers AI) and the opt-in off, the assistant panel says the provider is external and that the primary admin has not allowed sending mail to it, with a link to [Admin → Agent](/agent) for the primary admin, and chat stays off; automatic drafts are skipped with the reason in Activity. The opt-in is checked again before every step of a chat answer. **If your install uses an external provider for chat, the primary admin has to turn on the opt-in once for chat to keep working.**

## [2026.10.31.8] - 2026-10-31

### Added

- `GET /api/admin/attachment-storage` (admins) reports how many attachment rows and stored files there are, and with `?verify=1` checks that the newest 200 stored files still exist.

### Changed

- **Do not roll back to an older release once this one has run.** Older releases delete an attachment's file together with the message that has it, without checking whether another message shares it, so after a rollback deleting a forward draft, a sent draft or one of two messages that share a file would delete the other message's file too. Fix forward instead. If a rollback cannot be avoided, follow the [recovery runbook](https://github.com/midego1/kite/blob/main/docs/runbooks/recovery.md#rolling-back-past-attachment-sharing) first. Set the new environment variable `ATTACHMENT_SHARING=off` to stop new sharing (sends and forwards then store their own copies again); it is on by default. A backup taken after this release can only be restored into a database that has migration 0088 applied.
- Sending a draft and forwarding a message no longer store their attachments a second time: the sent message and the forward draft use the stored file of the draft or the original, so each file is kept once. Deleting a draft, a forward or a message removes a file only when no other message still uses it, and the database rows now go before the files, so a storage failure can leave an unused file behind but never a message whose attachment is missing. No migration is needed. Full backups, storage migrations and Admin → Storage count and copy a shared file once.
- The command center's **Today** and **Money Watch** cards now sit below the quick actions, so nothing you are about to click moves when they appear, and they no longer reload every time you close a message: their data is kept for a minute, and refreshed sooner after a change in Calendar or [Subscriptions](/finance).

### Fixed

- A trial whose payment failed now shows as **Payment failed** in the Money Watch card and in the search dropdown, and counts in the Subscriptions sidebar count, as it already did under Needs attention on the Subscriptions page.
- An event that started yesterday and runs into today now opens on today in the Calendar when you choose it in the **Today** card.

## [2026.10.31.7] - 2026-10-31

### Added

- The command center in the empty reading pane now shows a **Today** card with what is left of today's calendar (start times, or "Now" for what is under way, with a link to each event and to the Calendar) and a **Money Watch** card with your subscriptions that renew, end a trial or failed a payment this week (with a link to Subscriptions). Each card appears only while its module is on for you, loads after the pane is shown, and stays hidden when its data cannot be read. Modules add such cards through a new `reading-pane` slot ([Modules](/modules)).

### Fixed

- After you switch accounts, the For you suggestions already on screen load for the new account at once instead of staying empty until the next change.
- When the green **Database updated** notice leaves while it has the keyboard focus, the focus skips an element next to it that cannot take it (hidden or inert) and goes to the nearest one that can.

## [2026.10.31.6] - 2026-10-31

### Added

- With no message open, the reading pane now shows a small command center instead of "Select a message to read" alone: a greeting with today's date, the counts that matter (unread mail in the folder, messages in the Screener, open For you suggestions), your connected accounts with how each is doing (a failed sign-in gets a Reconnect link), quick actions (New email, Search, and the modules that are on), and for administrators what needs attention (the admin overview's list, with waiting database updates kept in the notice with its **Apply now** button and progress, plus a line for healthy backups and the database size). Everything comes from data the mailbox already loads or from the same requests the Settings and Admin pages make.

### Changed

- **What's new in Kite** loads its release notes when you open it instead of shipping them with every page, so the app downloads less.

### Fixed

- A reading layout chosen while your account's layout was still loading is saved when you close or leave the tab, instead of being lost. Turning off **Use the same layout on every device** in [Settings → Inbox](/settings/inbox) while the layout loads keeps this browser's layout, and signing in to another account no longer holds back that account's saved layout.
- Dismissing the green **Database updated** notice with the keyboard moves the focus to the element next to it instead of dropping it on the page, and switching to another window while the notice has the focus no longer lets it leave while you are away.
- After you open an older message of a conversation from a link and move it from the reader, the focus goes to the next conversation in the list instead of the list itself.
- For you suggestions in the sidebar and the reading pane refresh with one request per change instead of one each, and they no longer stay empty when a list opens right after you switch accounts.

## [2026.10.31.5] - 2026-10-31

### Changed

- "Kite was updated" at the top of a message list now looks like a message from Kite: the Kite logo as the avatar, the time the update was noticed, the subject ("Kite 2026.11.01.0 is ready" when the release changed) and a preview line with the first new note, unread until you open it. **Reload** and **Dismiss** are row actions that show on hover (always on touch screens). Opening the row shows what's new in the reader like an opened email, with the new release's notes as the body and **Reload** and **Dismiss** under them; on a phone it opens full screen with Back. It is still not a message: it is not counted, selected or moved, and `j`/`k` skip it.

## [2026.10.31.4] - 2026-10-31

### Added

- Connected accounts can send as addresses their sign-in does not prove: an **Other IMAP provider** account's own address, an account whose user name is not its address, and provider aliases. In [Settings → Connected accounts](/settings/connected-accounts), **Verify** or **Send from another address** mails a 6-digit code to the address; once it is entered, the address is in the composer's From menu and mail from it goes out through the account's SMTP server. Codes work for 30 minutes and 5 tries, are stored only as a keyed hash, and are limited to 5 an hour per user (3 for one address) and 10 a day per address; an address with 10 wrong codes in a day gets no new code until the next day. Needs migration 0089 (`external_identities`), applied from the admin overview.
- Print an email from the reader's ⋯ menu, or with Ctrl/Cmd+P while it is open: a clean page with the subject, From, To, Cc, date, attachment names and sizes, and the body with its quoted history unfolded, in light colours whatever the theme. In conversation view the toolbar's menu prints the whole conversation, oldest first; each message's own menu prints just that message. Remote images stay hidden unless you showed them, as in the reader.
- **Download PDF** in the same menus saves the email or conversation as a PDF named after the subject, with its text, headers and attachment names. It holds text only and Western European characters; for images, the original layout or other scripts, use Print and choose Save as PDF.

### Changed

- An unverified connected address is now listed in the From menu as **(Verify in Settings)** instead of being left out, and connecting or testing an account also tests its SMTP sign-in when its user name is not its address.
- The green **Database updated** notice that follows **Apply now** no longer stays until the page is left. It stays readable for about eight seconds, waits while the pointer or the keyboard focus is on it or the tab is in the background, then folds away as a tiny kite lifts off its corner and drifts out of view; a new **Dismiss** button on the notice takes the same way out at once. Under reduced motion it fades instead. The amber notice about updates that still need to be applied, and a failed run, stay until they are dealt with, as before.
- The inbox preview on the landing page (`/`) is now a live demo you can click through, on invented data and without any network request: open messages (the unread dot clears), switch folders (Inbox, Screener with Approve and Deny, For you with its suggestion cards, Starred, Snoozed, Sent, Drafts and the Receipts folder) and glimpse Calendar, Drive and Subscriptions; archive, snooze, star and trash with the same Undo as the app; Summarize shows a summary; Review draft opens a composer with the drafted reply, where Send only says "Demo: nothing sent"; search filters the list; the "Kite was updated" row can be reloaded away; and Kite AI opens a small chat with written answers. It works from the keyboard (j, k, Escape) and on a phone with one pane at a time. The frame still renders on the server; the interactive part loads in the background after the page is ready.
- The loading screen now says what it is doing: under the progress bar it lists the five steps of the start (loading Kite and its version, signing you in, checking the database, loading your mail, ready) and fills each in with the facts of this start as they come in, such as the account name, "Up to date" or how many database updates wait, how many mailboxes and unread messages there are, and how long the start took. Nothing extra is requested for it, and the reload safety nets are unchanged.

### Fixed

- Report spam in the reader now takes the whole conversation out of the list in conversation view (the default). It used to report only the open message, so the conversation's other messages stayed in the Inbox and its row kept showing. The reader acts on what the conversation's row stands for in the list you opened it from, as the row's own actions and a selection already did: a snoozed message of the conversation stays snoozed, and in Starred only the starred ones move. Report phishing, Archive, Move to trash, Not spam, Move to a folder and Block contact in the reader's toolbar work the same way; the actions on one message inside the conversation, and Report phishing on the phishing warning, act on that message alone, and with conversation view off the reader acts on the open message only.
- The reader closes and goes back to the empty pane as soon as the open message leaves the list, and the keyboard focus moves to the row next to it: Move to trash, Report spam or phishing, Archive, Not spam, a move to a folder, Block contact or Delete forever in the reader, the same actions on its row or in a selection, dropping it on a sidebar folder, **Mark as spam** on the phishing warning, and Snooze in the Inbox. It used to keep showing the message, selected, until the move back to the list had finished, which on a busy deployment could take long enough to look stuck. In Starred the message stays open, since Starred still lists it. **Undo** in the toast puts the message back in the list.
- A reading layout chosen while your account's layout could not be loaded (a slow first request right after a deploy, or a dropped connection) is no longer lost: the load is tried again a few times, and the choice is saved once it loads or every attempt failed. A layout loaded just after you changed something on this device no longer puts the old choice back.
- The automatic direct-upload setup under [Admin → Storage](/storage) says it took too long, rather than that the checks failed, when the checks were cut short by its time limit, and it cleans up a token Cloudflare created late on accounts with many API tokens.
- Very long mail is no longer searched for a one-time code at delivery, so its new-mail notification never carries one: a body of more than about 400,000 characters as received (the plain-text part, or the HTML when there is none, markup included) is skipped before any work on it, and otherwise more than about 100,000 characters of subject and readable text.

## [2026.10.31.3] - 2026-10-31

### Changed

- Database migration `0088_attachment_raw_storage` (apply it from the admin overview) prepares storing each mail attachment once: `message_attachments` gains the columns that let an attachment be served from its byte range of the stored raw message, and attachment objects no longer need a key of their own. Nothing is converted yet, and every attachment keeps downloading as before, also while the migration is still pending. Downloads, previews, inline images, large-attachment links, JMAP blobs, Save to Drive, forwarding, sending, the assistant and the risky-attachment check now all read attachments through one place, and full backups and storage migrations copy only attachments that have an object of their own. Design: `docs/specs/attachments-once.md`.

### Fixed

- On the self-hosted (Node/Docker) runtime, reading part of a stored file (the ZIP check of a risky attachment, a module reading the start of an attachment) no longer loads the whole file into memory first.

## [2026.10.31.2] - 2026-10-31

### Added

- "Reload Kite" and "Kite couldn't load" on the loading screen have a folded **Details** section with **Copy details**, for bug reports about a start that hangs. It says how far the start got, for how long the page was visible, how often the screen was mounted, which requests are still open, the slowest files and any frame that blocked the page for more than a second. It holds paths without query strings and without the token of a Drive or shared-file link, times and counts, never message content or addresses. When a page froze, the next load of the tab names the phase it froze at in the browser console and in Details.
- [Settings → Connected accounts](/settings/connected-accounts) has a forwarding guide for Gmail, Outlook.com and Microsoft 365, iCloud Mail, Yahoo Mail, Fastmail and other providers: the steps with your Kite address filled in, links to the provider's own forwarding settings and what to check afterwards. Choosing Outlook.com or Microsoft 365 when connecting an account, which Kite cannot connect yet, offers **Set up forwarding**.
- Mail that came in through a connected account (or was sent as one) shows a "via" chip in the message list and the reader, such as "via Gmail" or the account's label. Choosing it in the reader lists everything from that account, and the new `via:` search operator finds mail by provider, address, label or domain (`via:gmail`, `via:me@gmail.com`, `via:"Work mail"`).
- **Also sync the Spam folder** on a connected account (off by default) checks the provider's Spam folder too, from the moment it is turned on. That mail always lands in Kite's Spam: Kite's own spam filter still runs on it and its verdict is kept, with the provider's added, and mailbox rules and the Screener do not move it. No migration is needed.

### Fixed

- A loading screen that keeps being mounted again now gets "Kite couldn't load" after 30 visible seconds, even while it shows Reload Kite, and the 30-second limit holds again after **Try again** on a failed sign-in check. "Startup is taking longer than expected" counts only the time the tab was visible, so a tab opened in the background no longer shows it the moment you switch to it.
- Some messages could freeze the browser for seconds when opened, listed or replied to: very long runs of dashes before an email address, of `<` in a sender name, of dots or spaces in an attachment name, or of blanks in a colour or before a line break. These are now handled in linear time, as are conversations with thousands of participants. Long runs of broken characters in inbound mail no longer hold up the mail queue.
- Opening a large email, or reloading Kite while one is open, no longer freezes the page behind the loading screen. The reader prepares a message's body once instead of on every update while Kite starts, and looking for a one-time code in a long email no longer slows down on long links or long lines.

## [2026.10.31.1] - 2026-10-31

### Added

- While a send is held by the undo window, the bar now shows a **Send now** button next to **Undo**, a countdown, and the subject as a link to the queued message in Sent. Send now claims the held message with the same conditional claim the outbound queue uses, so it is never delivered twice and never both sent and undone (`POST /api/messages/{id}/send-now`, for the author only, like Undo; a send waiting for a connected account server's retry keeps its own schedule and answers 409). Sent refreshes when the hold ends. If the provider refuses the message, the bar says "Sending failed" and offers Edit; a send waiting for a connected account's retry cannot be hurried, and a late queue message of the undo window can no longer start a second retry chain (retries queued before this change are unaffected). From upstream Mailflare #210.
- Avatars that have loaded once (versioned URLs, which the server caches for a year) no longer flash their blurred preview on the next visit (from upstream Mailflare).

### Changed

- The self-hosted (Node/Docker) server now proxies remote images too, instead of letting the browser load them from their host: it resolves the host of the image and of every redirect and refuses private, loopback and reserved addresses, with the same per-user rate limit as on Workers (from Mailflare #220).
- The Activity listing of MCP tool calls and the pruning of old MCP tool call audit rows are faster on a large audit log: migration 0087 adds the index `audit_logs_action_created_idx` on `audit_logs (action, created_at)`. Apply it from the database update banner or the [Admin overview](/admin); until then everything works as before.
- The collapsed sidebar's icon rail now tints a folder with any colour you picked, the default blue included: a folder remembers whether its colour was picked, and one nobody coloured stays as neutral as the system folders. This replaces "a colour other than the default blue" in the earlier rail note. Migration 0086 adds `folders.color_is_custom`; apply it from the database update banner or the [Admin overview](/admin). Until then folders still list and save, and the rail shows a picked blue as neutral. Folders with any other colour stay tinted, as before.
- The landing page at `/` describes today's Kite instead of the 2025 routing tool: a hero with a preview of the inbox and reader built from the app's own styles (invented demo data), a feature grid by theme (mail with the Screener and spam protection, connected accounts, AI that asks before it acts, the modules, backups and storage, JMAP, API, webhooks and MCP, privacy), a "How it runs" section (your Cloudflare account or one Docker container, AGPL-3.0, the source) and the ways in: **Deploy to Cloudflare**, **Self-host with Docker**, **Sign in** and the source on GitHub. A signed-in user keeps the page with **Open dashboard**. It follows the light and dark theme and the style, fits a phone, and the "that actually flows" line now stays part of the headline in every style (Kite classic sets it in the script face).

### Fixed

- Reloading to a new version can no longer leave Kite on the loading screen with the kite floating on its string. The kite's return shows only on the one load right after Reload and for at most 8 seconds, so a refresh or an automatic reload shows the plain loading screen. A loading screen that is still up after 30 seconds without its own Reload Kite button now shows "Kite couldn't load" with a Reload button, even after the app has started, and Reload Kite counts from when the page started loading.
- The composer's message body fills the whole composer, so a click anywhere below the text puts the cursor in it, in the floating and the full-page composer (from upstream Mailflare #211).
- The notification service worker (`/kite-sw.js`) is no longer cached by the browser or the CDN (`Cache-Control: no-cache`, `updateViaCache: "none"`), so a new version is picked up on the next load (from upstream Mailflare).
- Being signed out when Kite reloads to a new version no longer shows the kite's return on the sign-in page.

### Security

- Risky attachments are flagged and their download waits for a warning: programs, scripts, shortcuts, installers and add-ins, macro-enabled Office and Excel data-connection files, files declared as a program, names with hidden right-to-left or control characters or an NTFS stream suffix, double extensions such as `invoice.pdf.exe`, web pages, disk images and archives. A flagged name is never shown inline, even when it claims to be an image. ZIP files are looked into without unpacking them (at most 1 MiB of directory) and flagged when they hold a program or cannot be checked. The reader, earlier messages in a conversation, drafts, Save to Drive and Drive's All attachments show the reasons and enable Download only after **I understand the risk**, and the server refuses an unacknowledged download with 409 (a guard against accidental clicks; JMAP downloads are not gated). Kite still has no antivirus; see "Risky attachments" in `docs/spam-protection.md` (from Mailflare #218).
- Attachment file names are cleaned before they are stored (control and bidi characters removed, `.` and `..` refused, at most 180 bytes with the extension kept), new attachment objects are stored under ids only so a sender's file name never becomes part of a storage path, and download headers drop those characters and cap long names too. JMAP blob downloads add `X-Content-Type-Options: nosniff` (from Mailflare #222).
- A large-attachment download link stops working while its message is in Trash, Spam or the Screener, or while its mailbox or owner is disabled, and always downloads as plain bytes (from Mailflare #222).
- **Insert link** in the composer builds the link with DOM calls, so a quote or `<` in the address can no longer inject markup (from Mailflare #221).
- Pages are served with `Cross-Origin-Opener-Policy: same-origin`, so a window Kite opens or that opens Kite gets no handle on it (from Mailflare #221).
- Webhooks, mail import, object storage and the remote image proxy refuse host names that embed a private IPv4 address (`10-0-0-1.example.com`) and wildcard DNS services such as `nip.io`, `sslip.io` and `localtest.me` (from Mailflare #220).
- A received reply joins a conversation only when the message passed DMARC for its own From domain, or when DMARC gave no result and its sender already takes part in the conversation; a failed DMARC check always starts a new conversation. A stranger who learned a Message-ID can no longer slip a message into a conversation, and a message whose Message-ID is already a conversation's key starts a new one, except the copy of a message you sent to your own address or alias. Someone newly copied from a domain without DMARC, or a mailing list without DMARC, starts a separate conversation until they are part of it. Mail import, connected accounts and JMAP drafts keep joining as before. Conversations no longer show Spam unless you open that message (upstream Mailflare #223).
- Received mail no longer renames a contact. Every message in the list, the conversation, the reader and the contact card shows the name you saved for the contact, else that message's own From name, else a name learned earlier, so a shared `no-reply` address keeps a different sender per message (upstream Mailflare #223, #226).
- The forwarding loop guard `X-Kite-Forwarded` is now signed per message (an HMAC over the Message-ID, keyed with `APP_ENCRYPTION_KEY`, else `INBOUND_WEBHOOK_SECRET`, else `CF_TOKEN`), so a sender can no longer switch account forwarding off for its message with `X-Kite-Forwarded: 1`, and a value read from a forwarded copy does not work on other messages. The pre-rename `X-Mailflare-Forwarded` counts only with the signed value. Installs without any of these secrets keep the unsigned value; set `APP_ENCRYPTION_KEY` to get the signed one. Two installs forwarding to each other stop after one extra hop. See "The forwarding loop guard" in `docs/sending-and-deliverability.md` (upstream Mailflare #223).
- New-mail notifications name the sender as "Name <address>" without control or direction-changing characters, and mail a rule or a block files in Trash no longer notifies, like Spam (upstream Mailflare #223).
- Senders first seen in Spam, Trash or the Screener, or first recorded by blocking them, are no longer looked up on Gravatar (upstream Mailflare #220).
- The `message.inbound` webhook is no longer sent for mail filed in Spam or Trash; mail held by the Screener still sends it (upstream Mailflare #224).

## [2026.10.31.0] - 2026-10-31

### Added

- Direct Drive uploads to R2 are now part of setup on Cloudflare: creating the first admin account uses `CF_TOKEN` to create an API token that may only read and write the `kite-raw` bucket, sets the bucket's CORS rule for the app, checks and saves the keys. Add the account permissions **Workers R2 Storage: Edit** and **Account API Tokens: Edit** to `CF_TOKEN` for this (see [Direct uploads at setup](https://github.com/midego1/kite/blob/main/docs/deployment.md#direct-uploads-at-setup)); you may remove the second after setup. If it cannot, setup still finishes.
- [Admin → Storage](/storage) and the [Admin overview](/admin) (under Needs attention) show "Direct uploads are off: set up (2 min)", with why the automatic setup failed, until direct uploads are on or the reminder is dismissed. **Enable direct uploads** starts with **Set up automatically**, which does the same in one click and names a missing permission; the guided manual steps stay below it.
- Migration 0085 adds the `storage_state` table, which keeps the automatic setup's outcome and the dismissed reminder. Apply it from the database update banner or the [Admin overview](/admin); until then the reminder shows without a reason and **Dismiss** waits for the update.
- **Add store** with Cloudflare R2 can create a new R2 bucket (with a suggested name, location and jurisdiction) or connect one picked from the account's buckets in one click, listing each step as it goes. A taken name offers to connect the existing bucket. Kite adds its CORS rule next to the bucket's other rules, and puts the policy back if the setup fails.

### Changed

- The [Admin overview](/admin) now starts with what needs attention: waiting database updates, a failed or missing backup, a restore that needs recovery, a database near its size limit, webhooks with failed deliveries, AI requests that failed in the last 24 hours and domains that are not active yet, each with a link to where to fix it, or "Nothing needs your attention". Under it, tiles count accounts, mailboxes and domains (and the database size for the primary admin) and open the matching page; the database, size and backup cards follow. Admins who are not the primary admin get the same list and tiles for what they may read, instead of an empty page.
- Requests to a saved store no longer follow HTTP redirects (this came with the Test connection hardening): a store behind a proxy that redirects must be saved with its final endpoint.
- A Test connection attempt refused by the limit keeps its single audit row, now marked `outcome: "rate_limited"`, and every attempt's row records its outcome.
- A forwarded message attached inline as `message/rfc822`, and each post of a digest, now shows as an `.eml` attachment instead of being merged into the body, so it is parsed only once. Attached messages do not count toward the limit of 10 attachments (from Mailflare #214).
- After upgrading, the daily raw mail sweep (02:00 UTC) works through the existing `inbound/` folder of the Mail store, up to 20,000 objects a day, and deletes raw mail older than a week that no message refers to. Raw mail of stored messages is never touched (see "Inbound mail limits" in `docs/operations.md`).

### Fixed

- A message with an oversized body, subject, address list or Message-ID is stored instead of failing and being dropped after its retries: large HTML bodies of delivered mail go to mail storage like imported ones, and the other fields are cut to fit (from Mailflare #217).
- Two first messages from the same new sender arriving at once no longer make one of them fail.
- Mail for an address that has no mailbox, alias or catch-all is refused with "No such recipient here" instead of being stored and then silently dropped. A failed routing lookup still stores the message, so nothing is lost (from Mailflare #219).
- Raw mail that nothing stores (no route, a reject rule) is deleted right away, and a daily sweep removes raw mail no message references a week after it arrived (from Mailflare #219). A message whose forward failed under a forward rule without a copy goes to the rule's mailbox, or is kept in mail storage and logged, instead of being dropped.
- When the routing lookup fails (the database is unavailable), mail is now stored for the queue even with account forwarding set up, instead of being refused with "Processing failed".

### Security

- `CF_TOKEN` needs **Account API Tokens: Edit** for the automatic setup, which lets it create tokens with any permission on the account (a leaked `CF_TOKEN` could then take the account over); Kite only uses it when setup runs or an admin selects Set up automatically or Create bucket and connect, and the docs and the dialog say to remove it afterwards. The setup ends within its time budget with its cleanup, never creates a second token for a bucket Kite already has a store for, and tokens it created stay in the account until deleted there. The token value and the derived S3 secret are never stored in clear, returned or logged.
- Incoming mail is checked before it is parsed: a crafted message with a huge header block, thousands of MIME parts, deep nesting or hundreds of thousands of short lines (in a body, a text attachment or an attached message) is refused with "Message rejected: …" instead of exhausting the Worker's CPU or memory or blocking the self-hosted server. Every path that reads raw mail goes through the same bounded parser (Cloudflare, the relay, SMTP, Resend, SES, imports, JMAP `Email/import`, automatic reading), and a message over the limits that still reaches the queue is dropped instead of retried; any other parse error is retried as before (from Mailflare #214).
- Turning HTML into text for snippets, search and automatic reading no longer slows down on unclosed `<style>`, `<script>` or `<head>` tags (from Mailflare #214).
- A plain-text message in `format=flowed` is unfolded in linear time: a 2.4 MB message of 39,000 flowed lines took about 25 seconds to parse and now takes well under one.
- Mail from Resend now carries its plain headers (at most 200, without any authentication or `Received` headers), so auto-replies, mailbox rules and automatic reading recognise automatic and list mail there too (from Mailflare #224).

## [2026.10.30.4] - 2026-10-30

### Added

- [Admin → Storage](/storage): **Test connection** in the Add store, Edit store and Enable direct uploads dialogs runs every check (endpoint, credentials, bucket, write, read, list, delete, multipart, signed link, CORS) without saving, and lists each with ✓ or ✗ and a fix in the provider's own words; a missing CORS rule comes with the rule for this site and a **Copy** button.
- The store form is grouped into Where, Credentials and Direct uploads, with provider presets: Cloudflare R2 asks only for the account ID, Amazon S3, Backblaze B2, Wasabi and Hetzner pick a region and build the endpoint, and each provider links to the page that creates its keys. The secret has a show and hide toggle, and mistakes are explained under the field.
- **Enable direct uploads** for the default R2 bucket is a four-step guide (create the token, paste the keys and account ID, test, save), and the Storage page and [Drive settings](/drive/settings) recommend it while Drive uploads still pass through the Worker.
- After **Reload** in the "Kite was updated" notice, the loading screen continues the story: the kite flies back in from the top right and floats on its string above the progress bar, its tail rippling and a cloud drifting by, until the new version is ready and the screen fades into the app. The screen follows your theme. Browsers set to reduced motion see the kite standing still with "Updating Kite…", and an ordinary reload keeps the plain loading screen.

### Changed

- The Admin menu groups its pages by task: Overview, People (Accounts, Activity), Mail (Domains, Mailboxes, Routing), AI, Modules (with each module's settings page), Data (Backups, Storage) and System (General, Branding, Alerts, API keys, Webhooks). Every address stays the same. Page titles now match the menu: the overview is "Overview", "Database Backups" is "Backups", "Admin API keys" is "API keys", and a mailbox's admin page is titled after the mailbox.
- The dyslexia-friendly font (OpenDyslexic) now has a **Use it for** choice under [Settings → Appearance](/settings/appearance), shown with the font and following your account like the font itself. **Text only** (the new default) sets emails, what you write, the message list's sender, subject and preview lines, thread summaries and assistant replies in it, while menus, buttons, labels, headers and the sidebar keep the normal interface font; **Everywhere** is how the font behaved before. If you had already chosen OpenDyslexic, you now get Text only; pick Everywhere to keep the whole app in it. Nothing changes when another font is chosen, and no font file is requested unless OpenDyslexic is.
- A saved store's check list folds into "All N checks passed · Checked <time>" with **Show details** when nothing failed, and the **Switch** button under Where data lives explains why it is unavailable.
- A refused access key or secret now says which one and why (a space or line break, or its length), instead of "That does not look like an access key pair".

### Fixed

- Applying database updates holds up better on slow or unreliable connections: a timed-out update is followed for up to 20 minutes before it is reported as unknown, a request that never answers is cut off once every update has landed, and other tabs show the busy state reliably, even while hidden.
- Dark mode no longer leaves dark text unreadable on mail that sets its own text colours, and no longer turns ordinary replies into inverted cards. Near-black text (Outlook's `color:black`, Gmail's `#222`) simply takes the theme's text colour. Mail with a background, or with a colour that would still be unreadable on dark (a dark-blue signature), is rendered light and inverted with links still blue. Light text is left alone. "Original colours" is offered above every message dark mode changed, in every layout and at every width, and also restores its quoted history: one small button at the top right of the message body, reachable with the keyboard, with one fixed label and a pressed state.

### Security

- The assistant's `get_thread`, automatic reading, automatic reply drafts and conversation summaries no longer read Spam, Trash, mail the Screener holds or other users' drafts from a conversation, so text an unapproved sender wrote cannot steer them (upstream Mailflare #225).
- JMAP `EmailSubmission/set` refuses to send a draft the AI assistant wrote until it was reviewed and confirmed in Kite, as the composer already did (upstream Mailflare #225).
- In assistant chat, changing or deleting calendar events is now a proposal you approve under the answer, listing each event and what would change; nothing changes before you click, and an approval is refused if the event was edited since (upstream Mailflare #225).
- The send review of an AI draft says the assistant wrote it and warns about recipients you have never written to and have not saved as contacts (upstream Mailflare #225). Recipients count as written to only once a message you sent them was delivered: auto-replies, invitation answers, booking notices and cancelled or undone sends no longer add them to your contacts, and invitation answers and booking notices no longer approve their recipients in the Screener.
- The MCP server tells clients that mail and calendar content is untrusted third-party text, marks every result with `contentTrust`, labels read-only and destructive tools, and records each tool call (tool, key and outcome, never content) in the audit log, kept for 90 days (pruned every five minutes and daily) and listed by `GET /api/audit-logs?action=mcp.tool_call` (upstream Mailflare #225).
- Mail that fails DMARC from a domain publishing `p=reject` or `p=quarantine` now goes to Spam, even from a saved contact or someone you have written to, and so does mail failing both SPF and DKIM without a DMARC result. A failure from a `p=none` domain, or one whose policy Kite cannot learn, still only adds to the spam score. A failed DMARC check, or a failed SPF or DKIM check without a DMARC pass, now cancels the trust a known sender otherwise gets, so a forged From no longer reaches the Inbox on that trust; forwarded mail that still passes DMARC keeps it (adapted from upstream Mailflare #216). Kite reads the policy from the receiving server's trusted results or SES, else from the domain's `_dmarc` record (cached, 3-second limit).
- New switch **Treat every DMARC failure as spam** under [Admin → General](/general) → Sender authentication, off by default, sends every DMARC failure to Spam. It needs migration `0084_add_spam_strict_dmarc`; apply it from the database card in Admin.
- Self-hosted: the built-in SMTP listener now checks SPF, DKIM and DMARC itself (with the MIT-licensed mailauth library) and records the result under `MAIL_HOSTNAME`, so the spam filter and the policy above apply to mail received on port 25. It adds a `Received` header with the connecting address, allows 100 sessions in total and 10 per address, 50 recipients per message and 60 seconds of silence, refuses a message over `SMTP_MAX_SIZE` without holding it in memory, and removes `Authentication-Results` headers a sender wrote under the listener's own name. For clients on private addresses only DKIM is checked, and the message's spam details say SPF could not be checked: the listener must see senders' real addresses, see [Self-hosting](https://github.com/midego1/kite/blob/main/docs/self-hosting.md#receiving-mail) (adapted from upstream Mailflare #215).
- Editing a store's endpoint, bucket, region, addressing or provider now asks for its access key ID and secret again: the saved keys only ever sign requests to where they were saved for. Storage checks no longer follow redirects and give up after 15 seconds.

## [2026.10.30.3] - 2026-10-30

### Added

- A dyslexia-friendly font. Under [Settings → Appearance](/settings/appearance), **Font** offers **Dyslexia-friendly (OpenDyslexic)** next to the bundled fonts: the whole app, the composer and plain-text emails switch to OpenDyslexic, with a little more room between letters, words and lines in what you read and write, and **Font in HTML emails** can replace the fonts of HTML emails with it as well. The font is self-hosted (SIL Open Font License 1.1) and its files are fetched only while it is chosen.
- The people in a conversation's header are now buttons. Hovering or focusing one shows the full address (with the other addresses the same person wrote from; a look-alike name from another domain stays its own chip); clicking or pressing Enter opens a small contact card with the address and a Copy button, **New email** (the composer opens addressed to them; not offered on read-only shares), **Search Inbox for mail from** (the Inbox list, filtered to exactly their address), **Add to contacts** or **Edit contact**, and **Block contact**. Your own address says "You" and offers only Copy. The sender's name in the message opens the same card, and it fits on a phone.
- Reload in the "Kite was updated" notice now sends the kite off: the logo lifts off the page, sways up and to the right out of view while the page fades, and the new version loads right after. Browsers set to reduced motion reload at once, and the reload never waits on the animation.

### Changed

- The **Font** choice under [Settings → Appearance](/settings/appearance) (Manrope, Geist, Inter, System font and the new dyslexia-friendly font) and **Font in HTML emails** now follow your account to your other devices with the reading layout, while **Use the same layout on every device** is on.
- Searching `from:` with a whole email address (`from:"hi@cursor.com"`) now matches that sender exactly instead of any address that contains the same words.
- Settings is regrouped into Account, Mail, Integrations and Data. Sending, the signature and automatic replies moved from Inbox and My account to a new [Settings → Composing](/settings/composing) page, and browser notifications to [Settings → Notifications](/settings/notifications); the Inbox page keeps reading, the Screener, spam protection and clean-up. Every address stays valid and `/settings/auto-reply` now opens Composing. Setting rows, form footers and field hints share one compact style across the settings pages.
- [Settings → My account](/settings/account) is one card: profile, recovery email, time zone and forwarding, without the extra "Account details" heading. [Settings → Appearance](/settings/appearance) groups the look (theme, style, font, text size) apart from the assistant's display choices and says once that they are saved in the browser. [Settings → Security](/settings/security) uses the same card layout, and the Screener's "Mail from new senders" choice on [Settings → Inbox](/settings/inbox) is two side-by-side options with its approved and denied senders beside each other.
- [Settings → Import](/settings/import) shows the sections to import as a visible list of checkboxes instead of a dropdown, [Settings → Export](/settings/export) names the mailbox it exports, [Settings → App passwords](/settings/app-passwords) and [Settings → API keys](/settings/api-keys) use the shared page header, and [Settings → Rules & routing](/settings/rules) lists mailbox rules more compactly with an empty state that explains what a rule does.
- **"Kite was updated"** now appears as the first row of your message list, with Kite's logo, a **Reload** button and a close button, instead of a toast in the corner. The row is not a message: it cannot be selected, is skipped by the keyboard shortcuts and never counts toward totals. Pages without a message list, such as Settings, still show the toast.

### Fixed

- Applying database updates no longer looks like the page has hung. **Update database** (Admin overview) and **Apply now** (the mailbox notice) turn into a busy "Updating database…" button and show the steps (the safety backup, then the updates one by one with how many are done), a progress bar and a running timer, and the browser warns before you close or leave the page meanwhile. When it finishes you see how many updates were applied, whether a safety backup was saved and how long it took; a failure or a backup restore in progress is explained, with the button available again.
- The collapsed sidebar's icon rail is aligned: every item (the menu button, New email, the folders, the assistant and the account) is the same 40px rounded square on one centred axis with one icon size, the active item is the same shape as a hovered one, and the unread count is a small pill on the corner that never covers the icon, with "99+" readable. Folders in the rail are as neutral as the system folders unless you gave them a colour other than the default blue.
- The Drive sidebar's icon rail matches the mail rail: the same 40px rounded squares and icon size, also for its New button. The rail keeps those sizes in a narrow window, and the sidebar's top and bottom fade shows only while the list is long enough to scroll.

## [2026.10.30.2] - 2026-10-30

### Added

- **New mail from connected accounts.** Kite now checks each [connected account](/settings/connected-accounts)'s Inbox for new mail every 5 minutes (or every 15 or 60, per account) and delivers it into the account's mailbox like mail Kite receives itself: spam filter, mailbox rules, the Screener, notifications, webhooks (`message.inbound` with `source: "external"` and the `accountId`) and automatic reading. Mail already read or starred at the provider arrives read or starred and without a notification; a message Kite already has from the same account, an import or its own sending (same Message-ID) is not stored twice, while a copy sent to the Kite address from elsewhere never hides the real one; a message the provider will not send is skipped and named instead of holding up the rest; mail refused for a while (permission or switch off) is fetched again once allowed; in a shared mailbox new mail belongs to the mailbox's owner; nothing at the provider is changed. **Check now**, **Pause**/**Resume** and the interval are on each account, which also says when it was last checked. A failed sign-in, an invalid certificate or a server that cannot be reached shows on the account and in a sidebar notice with **Reconnect**; throttled and unreachable servers are retried with backoff (at most every 6 hours). For Gmail and Google Workspace accounts Kite trusts Google's own `Authentication-Results` header (below Google's own `Received` line) for the spam filter. Checking runs on the existing cron and agent queue, on Workers and on the Node server.

### Changed

- An **Other IMAP provider** account names its own server, so its sign-in does not prove the address. Such an address no longer claims the address for the whole install, and connecting one never says whether the address is already connected elsewhere; addresses at the known providers stay unique. Apply database migration **0082** (`0082_external_account_address_scope.sql`) from the admin overview.

### Fixed

- A restore no longer fails on a foreign key when a message names a connected account the backup does not contain (an account connected while the backup was being written): the message is restored without it.

## [2026.10.30.1] - 2026-10-30

### Changed

- The reader toolbar is tidier: the × close button and the "1 of 12 unread" counter are gone, and the button that hides or shows the email list now sits at the far left, before the newer and older email arrows. In a single column (a phone, or No split) the same spot holds the Back button, so nothing strands you. Newer and older email still work with the arrows and with k and j.

## [2026.10.30.0] - 2026-10-30

### Added

- **Include mail files** under [Admin → Backups](/backups): every backup can also copy the raw mail, attachments and large message bodies to its own dated folder in backup storage, with a manifest. The page shows about how many files and how much space that takes before you turn it on, each full backup shows what it copied, and **Restore mail files** puts back the files that are missing without touching the ones that exist. Off by default, and the page says how much space the copies kept at once take, since every full backup holds its own copy. Files that cannot be copied or restored are counted and shown on the backup, with a retry button for the copy. Deleting a backup, by hand or by retention, deletes its copies too. Needs migration **0081**, applied from the [admin overview](/admin).

### Changed

- New installs back up daily and keep the last 14 days of backups. Existing installs keep their settings. **Delete old backups automatically** now stays visible on the Backups page while automatic backups are off, because it also removes manual and safety backups.

## [2026.10.29.11] - 2026-10-29

### Added

- Send as a connected account's address: once its SMTP sign-in works, the address of a connected Gmail, Google Workspace, iCloud Mail, Yahoo, AOL or Fastmail account is in the composer's From menu (an account at a server you entered yourself is not offered until its address can be verified), and mail sent from it goes out through the provider's own SMTP server, so it carries the provider's SPF and DKIM. Replies start from the address the mail came to, the message lands in Sent with its exact bytes, and a copy is saved in the provider's Sent folder (Gmail and Google Workspace keep their own). Undo send, scheduled sends and the sending allowance work as usual. Each account in [Settings → Connected accounts](/settings/connected-accounts) says whether you can send as it, with switches for **Send from this address** and **Save a copy in the provider's Sent folder**. Needs database migration 0083; see [Connected accounts](docs/external-accounts.md#send-as-the-accounts-address).
- A temporary refusal from the provider (`4xx`) is tried again after a minute and then after five; a refused password sets the account to **Sign-in failed**; and a connection that breaks after the message went out fails the send as "Delivery unknown" instead of sending it twice.
- The [admin overview](/admin) shows the latest successful backup, its size and how long it took, whether automatic backups are on, and a warning with the error when the latest backup failed.
- Restore a backup straight from its row in [Admin → Backups](/backups), without downloading and uploading it again. The restored backup stays listed.

### Changed

- Restoring a backup no longer loads it into memory. The file is read from storage in pages, checked completely before anything changes, and written in batches, so a backup larger than the Worker's memory restores. The safety backup before every restore and the automatic rollback when a restore fails part way work as before, and an uploaded backup file is streamed to storage first instead of being held in the request.
- A restore runs in the background, in steps that each save their progress, so closing the tab, a deploy or a restart no longer leaves the database half restored: the restore continues where it stopped, or rolls back. Only one restore runs at a time, and if a restore cannot be rolled back the admin overview offers to restore the data from before it with one click; no other restore can start until that is done. Database updates wait while a restore runs.

## [2026.10.29.10] - 2026-10-29

### Changed

- Pending database updates are now the first card in [Admin settings](/admin): it lists every pending migration, says that Kite saves a safety backup first when there is data to save (linking to [Backups](/backups)), and has a full-size **Update database** button.
- Admins other than the primary admin now see the waiting updates in Admin settings and in the mailbox notice, with the name and address of the primary admin, the only account that can apply them.

### Fixed

- Buttons on the sign-in, password reset, registration, booking and shared Drive pages stay disabled until the page has finished loading, then become active. A click or Enter before then no longer submits the form natively, which reloaded the page and, for **Send reset link**, put the address in the URL.

## [2026.10.29.9] - 2026-10-29

### Added

- Your reading layout follows your account: when you change the reading pane position, list density, conversation view or the size of the message list, the choice is saved to the account and applied in every browser you sign in to, with each browser keeping a copy for a fast start. A layout chosen before this release stays in its browser until you change it. A browser can keep its own layout instead under [Settings → Inbox → Layout](/settings/inbox). Needs migration `0080_add_user_preferences` (the new `user_preferences` table, included in backups); until it is applied, layouts stay in each browser as before.

## [2026.10.29.8] - 2026-10-29

### Added

- **Connected accounts** under [Settings → Connected accounts](/settings/connected-accounts): connect a Gmail, Google Workspace, iCloud Mail, Yahoo, AOL, Fastmail or other IMAP account with an app password, and import its mail from [Settings → Import](/settings/import) without typing the password again (**Sign in with**, or **Import mail** on the account). Kite recognises the provider from the address or the domain's MX records, tests the sign-in before saving, asks for your Kite password again, stores the account's password encrypted with `APP_ENCRYPTION_KEY` and never shows it again. **Test connection**, **Edit**/**Reconnect** and **Remove** (the mail stays) are on each account. Outlook.com and Microsoft 365 need Microsoft sign-in and cannot be connected yet.
- Admins control the feature with **Allow connected accounts** under [Admin → General](/general) (on by default only when `APP_ENCRYPTION_KEY` is set) and per user under Admin → Accounts → Permissions, which also shows how many connected accounts a user has and in which states. While either is off, accounts cannot be used or edited, only removed, and their passwords are erased by the daily run after 30 days.
- Needs database migration **0079** (`0079_add_external_accounts.sql`), applied from the admin overview; until then the page asks for the database update.

### Fixed

- The Calendar's day and week grids no longer clip the text of short events, tentative ones included. A one-hour event shows its title and time in full, and a shorter one shows a single line, "Title, 10 AM", cut with an ellipsis at the end when the column is narrow, so the title stays readable. The part of an event that continues past midnight says "until 12:30 AM" instead of repeating the start time of the day before.

### Security

- Connected account passwords are left out of backups; a restored account has to be reconnected. Connection attempts are limited to 10 per user in 10 minutes (checked before the Kite password), a saved password is never sent to a changed server (changing a server or the user name needs the password again), connection tests refuse private and local servers and ports other than 993, 143, 465 and 587, and are recorded in the audit log without the password or user name.

## [2026.10.29.7] - 2026-10-29

### Fixed

- #130 A draft no longer keeps text you had already undone. If you changed the message and changed it back while the first change was still being saved, the draft ended up with the change; now the change back is saved too, also when you close the composer right away.

## [2026.10.29.6] - 2026-10-29

### Added

- Message list rows with a real attachment now show a small paperclip next to the date, in the stacked and the wide row at every density. In conversation view the paperclip shows when any message of the conversation in the folder you are viewing has one. An image that is only embedded in the message body (referenced by its content ID) does not count. `GET /api/messages` rows carry the new `hasAttachments` field.

## [2026.10.29.5] - 2026-10-29

### Changed

- The button that collapses the sidebar moved from the sidebar header to the left of the title in the message list header (Inbox, folders, search, All mailboxes, Drafts, Sent). The icon rail keeps its own **Expand menu** button, and phones keep the **Open menu** sheet.
- The account menu (your name and address, Inbox, Calendar, Drive, Booking, Settings, inboxes, reading pane, density, Admin, Add another account, Sign out) now sits at the bottom of the sidebar, as the last item under Settings, Support and the version line, and opens upward. In the collapsed icon rail it is your avatar at the bottom, and the phone menu sheet ends with it. The mailbox avatars stay at the top.

## [2026.10.29.4] - 2026-10-29

### Changed

- The title of a message list ("Inbox", "Archived", a folder name) is no longer cut off when the list is narrow. The list header drops the Kite AI button and the sidebar toggle, and below 20 rem of list width "Select" shows only its icon. Open Kite AI from the **Assistant** item in the sidebar, the button in the reader toolbar, the `.` key or the command palette; collapse and expand the sidebar with the button in its header, which stays in the icon rail, and the collapsed rail shows the assistant as an icon.

### Fixed

- A send that was moved to Drafts after it stalled (**Move to Drafts** on a message stuck in "Sending…") can no longer be turned back into a sent or failed message by the worker that was still delivering it. The message stays the draft it is, the job keeps the state recovery gave it, no "message failed" webhook is sent for it, and a worker that finds its send already taken back does not deliver at all. A delivery that still went out is recorded in the audit log.

## [2026.10.29.3] - 2026-10-29

### Fixed

- Web addresses and email addresses in a message are links in the reader. A plain `https://…` or `www.…` address, or an email address, in the text of an email, in a text-only message and in the quoted earlier messages now opens in a new tab (mail addresses open your mail app), the same as links the sender made; the full stop or closing bracket after an address is not part of the link, text that is already a link or sits in code is left alone, and an address that hides its real host behind a `user@` prefix is not linked.
- A web or email address you type in the composer becomes a link when you press Space or Enter after it, and any you did not finish with a space (such as one pasted at the end) are linked when the message is sent. The plain-text version of the message stays plain.
- A message you send with an undo delay or schedule for later now appears in Sent at once, instead of nowhere until it went out. Its row says "Sending…" (undo delay) or "Scheduled · Oct 30, 9:00 AM", and a send that failed says "Failed to send". Opening it shows when it goes out; its author can **Cancel send** (it returns to their private Drafts) or **Edit** it in the composer, and a failed one offers **Edit and resend** or **Move to Drafts**. Once it goes out it is an ordinary Sent email. The Sent count, the previous/next arrows in Sent and the conversation view include these messages too. Cancel send and Edit are offered only until delivery starts; a send that is being delivered reads "Sending…", and one still unfinished after 10 minutes reads "Stuck: still sending after N minutes" with a **Move to Drafts** recovery. A message waiting to go out cannot be archived, trashed or marked as spam until it is cancelled, since it would be sent anyway: those actions are refused with a notice and the toolbar buttons are off.
- Reloading Kite, for example from the "Kite was updated" message, no longer leaves the page on the logo with a progress bar that never moves. When the app's files stop arriving without failing, Kite reloads by itself, twice at most, and then shows "Kite couldn't load" with a Reload button instead of loading forever. It acts after 8 seconds of visible time once nothing is loading any more, and waits while files keep arriving: only 20 seconds without progress (10 after such a reload, or 60 seconds in all) count as stuck, so a load that stays stuck shows the message after about 40 seconds.
- A failed sign-in check while Kite starts is retried twice (a timed-out one once, so it gives up after about 11 seconds) and then shows "Kite couldn't check your sign-in" with Try again and Continue anyway, instead of opening the app without your account (empty admin menus). It also tries again when you return to the tab or come back online. A signed-out session still goes to the sign-in page.
- A failed branding request no longer resets a custom app name and icon to Kite's own.
- A Kite tab that was still loading when the browser froze or hid it (switching apps on iOS, a background tab on Android or in Chrome) no longer reloads itself as soon as it is shown again. Only visible time counts toward deciding that loading is stuck.

## [2026.10.29.2] - 2026-10-29

### Changed

- The usage statistics notice no longer sits in the mail sidebar, Settings or the module pages. It is shown above the [Admin](/admin) pages only, where the details and both choices (**Turn off**, **Keep on**) are, and in [Admin → General](/general) and the setup section as before. Nothing starts before the primary admin has seen the notice, so an install whose owner never opens an Admin page is never told and sends nothing. **Turn off** is still final.
- An install that was told a start date under the old 14-day rule (such as 12 November 2026) and has not turned statistics off or kept them on moves to the current rule: statistics start at the first 02:00 UTC run at least an hour after this version is running, and the notice names that date, coming back on the Admin pages if the owner had hidden it. Dates only ever move earlier, and installs that already chose are not touched.

## [2026.10.29.1] - 2026-10-29

### Added

- Select several emails in a list the way desktop mail clients do. Click an email to open it, then Shift-click another to select every email in between (Shift-click again to move the end of the range), or Cmd-click (Ctrl-click on Windows and Linux) to add or remove single emails without opening them; if an email is open, it joins the selection first. Cmd/Ctrl+Shift-click adds a range to the selection. In conversation view a row stands for its whole conversation. Shift+↑ and Shift+↓ extend the selection from the keyboard, and Escape clears it. Only emails that are loaded on the current page are selected, so a range never reaches onto the next page. Cmd/Ctrl-click on an email no longer opens it in a new tab (it selects it); middle-click still does. Shift-click on a row checkbox now selects a range the same way, and phone gestures work as before. Escape only clears the selection: an open email stays open.

### Changed

- Usage statistics no longer include how many messages came in and went out (`inbound_1d` and `outbound_1d`). The report is now a random install id, the Kite version, Workers or Node, which modules are on, and ranges for accounts, active accounts, mailboxes and active mailboxes. The collector accepts reports from older installs that still send the two fields and ignores them; run its migration `0003` to drop what it stored (it is not part of the Kite app, so no Kite migration is needed).
- The usage statistics notice, the setup section and the card in [Admin → General](/general) now say what the report is for: so the Kite project can see how many active installs there are, which versions, runtimes and modules they run, and roughly how many accounts and mailboxes they have and use, with rough counts only and no IP addresses stored by the collector. With `KITE_TELEMETRY_URL` set to another collector, the notice, setup section and card say only that reports go to that collector. What is sent otherwise, how often and the start date are unchanged, and they name "the Kite project" instead of a person.
- The privacy page and the deployment docs name "the Kite project" as the controller of the usage statistics collector instead of a person, and describe the same purpose. The contact address and the collector address are unchanged.
- An install that never chose no longer waits 14 days: usage statistics start at the first 02:00 UTC run at least an hour after the primary admin first saw the notice (tonight's run when it was first seen before 01:00 UTC, otherwise tomorrow's), and the notice names that date and, when your time zone reads differently, the same moment in it. Nothing is sent before the notice was on screen, **Turn off** is still final, **Keep on** still starts with the next daily report, new installs are unchanged (the setup switch decides), and a date announced before this change keeps its date.

### Fixed

- **Exactly what is sent** in the usage statistics notice opens the list of fields in place. It was a link to the page the notice is on, so it did nothing in Admin → General. The short notice in the sidebar links to the card (`/general#usage-statistics`) and scrolls to it.

## [2026.10.29.0] - 2026-10-29

### Added

- [AI usage](/ai-usage) is much more detailed. Hover over or focus a bar in the chart (arrow keys move between days) to see that day's input, output and total tokens, requests, failures, estimated cost, requests without a rate, and a breakdown by model and by feature. Switch between the last 7, 30 or 90 days, and chart tokens, cost or requests. New sections show today's spend against the install's daily cap, the token allowances and each mailbox's own cap; succeeded versus failed requests with the most common errors; and breakdowns by model, provider, feature and mailbox (only mailboxes you can open are named), each with requests, tokens, cost and share. The activity table filters by model, provider, feature and status, and each row opens to show its feature, mailbox, status or error, duration, finish reason, cost and the rate it was counted at.
- Kite's price list now has DeepSeek's models (`deepseek-flash`, which serves DeepSeek V4.1 Flash, and `deepseek-v4-pro`), counted at DeepSeek's peak rate.
- Attachments in the composer open: a click previews an image, PDF or text file in the same viewer the reader uses (other types download), and each chip has a "…" menu with Preview, Download and Remove. It works for files you just attached, for files carried over by Forward, and in both the reply docked in the reader and the full composer. Chips show a thumbnail for images and keep the file extension visible when a long name is shortened.
- Save several AI providers in [Admin → Agent](/agent) and switch between them with **Use this provider**, without typing the API key or models again: each saved provider keeps its name, base URL, sealed key, models and rates, and exactly one is in use for chat, Write with Kite, automatic reading, summaries and spend. A new provider is used only when you tick **Use this provider now** (or when nothing at all is set up), and switching to another external vendor while external providers may read mail asks for confirmation first. The provider in use cannot be deleted; switch first. Adding, editing, switching and deleting a provider are listed on [Activity](/activity).
- A saved API key that can't be decrypted (for example after restoring into an install with another `APP_ENCRYPTION_KEY`) no longer breaks Admin → Agent: the provider shows "key unreadable, enter it again" and AI requests say so.
- A mailbox whose chosen model the provider in use does not offer uses the provider's default model, and its assistant settings say so.

### Changed

- Requests that stored no cost, because they ran before their model had a rate, are now priced on [AI usage](/ai-usage) at today's rate and marked estimated, instead of being left out of the spend. A request that ended before the provider reported its usage keeps its reserved estimate, also marked estimated, and one left open after a worker stopped shows as interrupted. The page lists the models that still have no rate, with a link to set one in [Admin → Agent](/agent).
- An answer that hit the output limit is recorded as failed with "cut off" in every feature, and its tokens still count. Automatic drafts (auto-drafting with autonomy off) now refuse such an answer, as Write with Kite does, instead of saving a draft that ends mid-sentence.
- **Database migration 0078** adds status, error code, duration, finish reason, the rate used and whether the cost is an estimate to each AI usage row. Apply it from the Admin overview; until then AI usage shows those details as not recorded and everything else works as before.
- Database migration 0077 adds the saved providers and copies the provider configured until now into the first one. Apply it from the admin overview; until then Admin → Agent keeps the single provider form and works as before. Once a saved provider is in use, the old single-provider settings (key included) are cleared.
- Sign-in, first-run setup, onboarding, password reset and the two-step code have the new look: one bordered card on the page background, with the product name above it. **Kite classic** keeps its script line under the card.
- The public booking pages and shared Drive links look like the rest of Kite: bordered cards and lists, a quiet header, and buttons and fields in the same style. Shared Drive links follow the light or dark theme without the near-white background they could show in dark mode.
- The "Page not found" page and the shared dialogs (forms, confirmations, the command palette, the keyboard shortcuts, the account menu and the send preview) use the same rounded, bordered panels. The **New mailbox** form on [Admin → Mailboxes](/mailboxes) and the contact details scroll when the window is short.

### Fixed

- With a router provider (OpenRouter, Haimaker or a custom API), a model id with the vendor in front (`anthropic/claude-opus-5-5`, `deepseek/deepseek-v4.1-flash`) now gets the vendor's price from Kite's price list. Such models now count against the daily dollar spend cap instead of the token allowances.
- The size notice under the attachments ("Cloudflare limits general email messages to 5 MiB…") only shows when a file will be sent as a download link or the files come close to the message limit, no longer for every attachment, and not at all when the From domain sends through Resend or SES, which take big files directly (the Attach button's tooltip follows).
- The text Write with Kite suggests is readable in dark mode: the preview had a near-white background with light grey text.

### Security

- Drafts are now private to their author in shared mailboxes. Another person with access to the mailbox, its owner and administrators included, no longer sees your drafts in Drafts, counts, search, mailbox export, the REST API or JMAP, and opening one of them or its attachments by link answers "not found".
- A draft now leaves Drafts only by being sent or deleted. **Delete** removes drafts at once with their attachments, after asking and without Undo, instead of moving them to Trash: in Drafts, and in Starred, search results or All mailboxes, where a notice says how many drafts were deleted permanently and Undo covers only the rest. You can delete your own drafts with Send as or Send on behalf access too. Drafts no longer offers Archive, Report spam or Move to, and the server and JMAP refuse to move a draft elsewhere or a message into Drafts.
- Removing a member from a shared mailbox deletes their drafts in it; the confirmation says so.

## [2026.10.28.1] - 2026-10-28

### Added

- Kite now ships a price list with the official per-token prices of well-known models (Anthropic Claude including dated ids such as `claude-haiku-4-5-20251001`, OpenAI, Google Gemini, Workers AI's text models and Groq), each with its source and the date it was read. Models the provider does not price in its model list, such as Claude through the Anthropic API, now show dollar costs on [AI usage](/ai-usage) again. Under **Estimated cost rates** in [Admin → Agent](/agent) these rates appear greyed with "From Kite's price list (as of …) · source"; **Override** sets your own rate and **Use Kite's price** goes back. Your own rate comes first, then a rate the provider publishes, then the price list. The list is updated with Kite releases.
- Admin → Agent shows what was spent today next to the daily spend cap.
- **Import a whole account.** [Settings → Import](/settings/import) → IMAP → **Whole account** lists the account's folders with their message counts and sizes and proposes where each goes: Inbox, Sent and Archive to the same places in Kite, your own folders to Kite folders of the same name (nested ones as `Parent / Child`), Spam and Trash offered but unticked, Drafts left out. Every row can be changed. One background job then copies the folders one after another; a message in two folders lands once. A folder the server cannot open is skipped and the finished import says how many were; a busy or throttling server is retried later.
- On Gmail, All Mail is copied once and each message is filed by its labels (Inbox, else Sent, else its first label as a Kite folder, else Archive), so labels no longer import the same message several times.
- Imports can be paused and resumed from the jobs list, which now shows each folder's progress. A paused import keeps its place and its saved password for up to seven days.
- Apply database migration 0076 after deploying, from the database card on the admin overview or the banner in the mailbox. It adds the folder list of whole-account imports; until it is applied, only one-folder imports can start.
- The **What's new in Kite** dialog has a list of releases on the left ("Unreleased" first, then every version with its date, and "Current" on the release this build is running). Click one to jump to its notes; the list highlights the release you are reading as you scroll, and works with the up and down arrow keys. On a phone the list is a menu at the top. Notes further down are drawn only as you scroll to them, so a long changelog opens quickly.

### Changed

- Models that get a rate from the price list count against the daily dollar spend caps instead of the input-token allowances, from the moment this release is deployed. The install's cap defaults to $2.00 a day, which an expensive model (Claude Opus 5.5 at $4 / $20 per million tokens, for example) reaches sooner than the 2,000,000-token allowances: check the cap under **Automatic reading** in [Admin → Agent](/agent) and raise it if automatic reading or chat should keep running. Spend recorded earlier today without a rate counts as $0.
- Which model automatic reading and one-line summaries use is unchanged: without a triage model chosen for the mailbox they still pick the cheapest model among the rates entered or published in Admin → Agent, and rates from the price list are not considered for that choice.
- Imported mail whose HTML body is larger than 16 KB keeps that HTML in the Mail store instead of the database, so a large import fills the database much more slowly. The message, its conversation, replies and forwards, search, the assistant, JMAP, the REST API and the mbox export read it as before; search uses the message's text, or the text of its HTML when it has no text part. Switching the Mail store under [Admin → Storage](/storage) moves these bodies too, and a mailbox export that cannot read one fails with a message to try again rather than saving that message as text. Database backups carry the reference but not the HTML itself, like attachments, so back up the Mail store too. Needs migration 0074, applied from the Admin overview; until then imports keep the HTML in the database. Mail Kite receives itself is unchanged.
- Uploaded `.eml` and `.mbox` files now keep the state their messages carry in their headers: the mbox `Status` and `X-Status` headers and Gmail Takeout's `X-Gmail-Labels` (`Unread` means unread, `Opened` or Gmail's own labels without it mean read, `Starred` stars) set read and starred, and mail labelled Spam or Trash, or, without Gmail labels, marked `X-Spam-Flag: YES`, is filed in Spam or Trash instead of the Inbox. Only an upload to Inbox is refiled; any other destination you pick is kept. Mail that says nothing arrives unread, as before.
- IMAP imports keep the source's read and starred state: mail read there is read in Kite, and flagged mail is starred. Mail without a `Date` header gets the date the source server received it instead of the time of the import. Uploaded `.eml` and `.mbox` files arrive unread, as before.
- Imports skip a message the mailbox already holds whether its Message-ID was stored with angle brackets or without, so importing a provider's Sent folder no longer adds copies of mail sent from Kite. A message without a Message-ID is recognised by a SHA-256 hash of its bytes, so running an import again only adds what is missing. Messages imported without a Message-ID before this release were keyed differently and can be added once more by a re-run.
- The IMAP import form's **One folder** mode replaces the earlier choice of sections, which started one background job per folder.
- Usage statistics are now **on by default**, and nobody's install starts sending without being told first. Apply database migration 0075 after deploying, from the database card on the admin overview or the banner in the mailbox; until it is applied nothing changes. **If your install existed before this release** and you never chose, Kite does not start on its own: the first time the primary admin opens Kite, a notice in the sidebar and above the [Admin](/admin) pages says, for example, "Kite will start sending usage statistics from 02:00 UTC on 12 November 2026 unless you turn them off", with **Turn off** and **Keep on**. The date is at least 14 days after the notice is first on screen and does not move; hiding the notice keeps it. If the date comes while `KITE_TELEMETRY=0` is set or no collector address is usable, nothing starts and a later notice names a new date. Until then nothing is sent and no install ID exists. **If you turned statistics off before, they stay off**, with no notice; if you turned them on, nothing changes.
- New installs: the last step of the first-run setup has a **Usage statistics** section that explains what is sent (ranges, never exact numbers; no names, addresses, domains or message content), how often (once a day, around 02:00 UTC), to whom (Michiel de Gooijer (midego), privacy@midego.net), how long it is kept (90 days, then only totals) and that it is pseudonymous, with a **Send usage statistics** switch that is on. Nothing is recorded or sent before the account is created, and with the switch off no install ID is ever made.
- You can still turn statistics off at any time under [Admin → General](/general), which deletes the install ID and asks the collector to erase its reports. `KITE_TELEMETRY=0` (or `false`, `off`, `no`) turns them off for the whole deployment, including the setup switch and the notice, and an empty `KITE_TELEMETRY_URL` sends nothing.
- The privacy page now gives legitimate interest, with notice and an easy opt-out, as the legal basis instead of consent, and the README, deployment and self-hosting guides say statistics are on by default and how to turn them off. See [Privacy → Usage statistics](https://github.com/midego1/kite/blob/main/docs/privacy.md#usage-statistics).
- [For you](/for-you), [Activity](/kite-activity), [Subscriptions](/finance) and [Drive](/drive) have the new look: a slim title bar with the page's actions at the top of the panel, bordered cards and lists, muted section labels and empty states. Drive's menu matches the mail sidebar, with your mailboxes at the top, **New** as a full-width button and the operational notices above Settings.
- [Calendar](/calendar) and [Bookings](/booking) show the upcoming events and the calendar or booking list as rounded panels, with a quieter toolbar: a Bookings/Calendar switch, small square arrows, **Today**, the view menu and **New event**. The view menu is now the same menu as elsewhere.
- The search suggestions under the mail search and the contact details follow the new look too, and the usage statistics notice above the Admin pages uses the same muted amber as the other notices.
- Settings and Admin have the new look of the mailbox: the same sidebar, with its notices, beside rounded panels. The Settings or Admin menu is a panel of its own, with the page search at the top, the **Settings**/**Admin** switch under it and muted group labels; the page beside it shows where you are (for example *Settings / Personal / Inbox*) and a **Need a hand?** button. On phones the sidebar and the menu open as sheets, as before.
- Every Settings and Admin page uses the same parts: a page title with its line and actions, bordered cards, lists of rows, tables with muted headers, empty states and quieter success, warning and error notes. Drop-down menus on [Admin → Alerts](/alerts), [Admin → Agent](/agent), new domains, routing rules and [Settings → Inbox](/settings/inbox) are now the same menus as elsewhere, and badges are no longer in capitals.
- Buttons, fields and the database cards on the [Admin overview](/admin) follow the Zero look too; **Kite classic** keeps its own colours on these pages.

### Fixed

- The Kite AI side panel is now a panel like the message list and the reader: the same top and bottom edge, the same gap, a rounded border with the same soft shadow, and a header as tall as the list's, so the bottom borders line up.
- In a short window the sidebar's menu keeps scrolling above Settings and Support, so the Folders heading is no longer half hidden behind them; a tall notice scrolls inside the bottom group instead of squeezing the menu.
- Cancelling a whole-account import while it is opening a folder no longer leaves that folder shown as running, and the import stops instead of opening the folders after it.
- Two workers can no longer work on the same import at once. A running import renews its hold on the job every minute, so a source server that takes minutes to answer does not lose it, and a worker that did lose it (for example after being stalled) can no longer save progress, extend or clear the new worker's hold, or finish the job.
- Resuming an import whose worker died starts it again within about three minutes, instead of waiting for the old eight-minute hold and the next five-minute check.
- An import that pauses because the database is nearly full keeps its hold on the job until its last fetch has finished.
- IMAP imports no longer accept an impossible receipt date from the source server (minute 60, a zone offset of 99 hours, a year before 1970); such a message keeps its `Date` header or the time of the import.
- An imported message dated more than a day in the future, by its `Date` header or by the source server, is dated by the next believable date (the server's receipt date, else the time of the import), so a source can no longer pin mail to the top of the list.
- Imported conversations no longer split when a reply is imported before the message it answers: the reply joins the conversation of the first message its `References` header names. Received mail is grouped as before.
- Reloading right after a new version of Kite is deployed, from the "Kite was updated" notice or by hand, no longer sometimes leaves the page on "Loading" until a second refresh. When the page names app files that do not load (for example while a deploy is still reaching every location), Kite now reloads by itself, a few times with a growing wait. A tab that is already open and cannot load part of the previous version checks for the update at once and shows the notice instead of failing silently.
- The usage statistics notice no longer appears twice on the Admin pages. Admin shows the full notice above the page; the short one in the sidebar now appears only in the mail views and Settings.
- The **Setup** buttons in the DNS rows of [Admin → Domains](/domains) were hard to read, most of all while DNS is managed by hand; they now have a solid face and readable text in light and dark mode.
- On phones, bordered cards in Settings, Admin and Money Watch kept no side padding, so their text touched the border.

## [2026.10.28.0] - 2026-10-28

### Added

- [Admin → Agent](/agent) lists the last 20 **Recent AI errors** (feature, code, model, provider, HTTP status, duration, token counts and finish reason; never what was asked or answered), so the primary admin can see what failed without server access. Only provider and model failures are listed, not refusals such as a spend cap or the rate limit. They are kept in the audit log; no migration is needed.
- A **Kite AI** button in the top right of the message list and the reader toolbar opens and closes the assistant, and **Open Kite AI** is in the command palette. The `.` key toggles it and is listed in the shortcuts sheet (`?`).
- Undo for Report spam and Report phishing, from the toast that follows. It puts the message back where it was and takes back exactly what the spam filter learned from the report, and a phishing report's Undo also unblocks the sender when that report placed the block and reopens the warning it closed. Undoing a move to Spam in the assistant chat or Mark as spam now untrains the filter too. Until the database update is applied, Undo only moves the mail back.
- The admin overview shows the database size against its limit (10 GB on Cloudflare D1; set `D1_MAX_BYTES=500000000` on Workers Free), amber from 70% and red from 90%, and a new operational alert "Database nearly full" fires at 90%.
- [Settings → Import](/settings/import) estimates what an import adds to the database, warns from 70% of the limit and asks for **Import anyway** above 90%. A running import pauses itself at 90% and keeps its saved credentials until you resume it, which asks for confirmation while the database is still full. No migration is needed.
- Design spec for external mail accounts (`docs/specs/external-accounts.md` in the repository): importing a whole IMAP account with read and starred state, a database size estimate and warning before large imports, keeping new mail arriving from a connected account, sending as the external address through the provider's own SMTP server, and OAuth for Microsoft and Google. Nothing changes in the app yet.
- IMAP imports, including background jobs, now work on the Node/Docker runtime. Kite resolves the server's name itself and refuses it when any address is private; set `EXTERNAL_ACCOUNTS_ALLOW_PRIVATE_HOSTS=1` to import from a mail server on your LAN (loopback and link-local addresses stay refused), and `EXTERNAL_ACCOUNTS_EXTRA_PORTS` (for example `1143`) for a bridge such as DavMail or Proton Mail Bridge (see [Self-hosting](https://github.com/midego1/kite/blob/main/docs/self-hosting.md)).
- IMAP imports sign in with `AUTHENTICATE PLAIN` when the server offers it, and fall back to `LOGIN`.
- **One-line summaries in the message list**, off by default: under **Summaries** in the [assistant settings](/inbox), people who manage a mailbox can have Kite write a line of at most 140 characters for new mail and show it in the list instead of the first words, with **Include newsletters and notifications** (off by default) and a daily limit of requests (100 by default; a request that brought no usable line counts too). When automatic reading already asks the model about a message, the line comes from that same request, so nothing is summarised twice; otherwise a small request of its own writes it. Spam, Trash, the Screener's held mail, drafts, suspicious mail, mail with a phishing warning or phishing signs, muted senders and short mail never get one, and lines follow automatic reading's switches, external-provider opt-in, pause, burst limit and spend caps. Lines arrive without a reload, are deleted with their message, and each browser can show previews instead under [Settings → Appearance](/settings/appearance). Uses the columns migration **0072** added.
- Apply database migration 0071 after deploying, from the database card on the admin overview or the banner in the mailbox. It adds the `telemetry_state` table for usage statistics; until it is applied, they stay off and [Admin → General](/general) asks for the update.
- Usage statistics, **off by default**. The owner can turn them on under [Admin → General](/general). Kite then sends one small, pseudonymous report a day, around 02:00 UTC: a random install ID made when statistics are turned on, the Kite version, Workers or Node, which modules are on, and ranges (never exact numbers) for how many accounts, active accounts and mailboxes there are and how many messages came in and went out in the last day. It never contains names, email addresses, domains, `APP_URL` or message content. The request can say more than the report: on Cloudflare Workers, Cloudflare adds a `CF-Worker` header naming your domain that Kite cannot remove, and on Node/Docker the collector sees your server's IP address; the collector reads and stores neither, though Cloudflare's own analytics may sample IP addresses. Reports go to `kite-telemetry.midego.net`, run by Michiel de Gooijer (midego) on Cloudflare on the basis of your consent; daily reports are kept 90 days, then only totals without the ID, which are public at `https://kite-telemetry.midego.net/v1/summary` (with small groups hidden). Data requests: privacy@midego.net.
- Turning statistics off deletes the install ID and asks the collector to erase that install's reports. If the collector cannot confirm it, the card shows the ID with a **Copy ID** button to send by email. Turning statistics on or off is listed under [Admin → Activity](/activity).
- Operators can set `KITE_TELEMETRY=0` to keep statistics from being turned on or sent (the owner can still turn them off), `KITE_TELEMETRY_URL` to send them to another collector, or an empty `KITE_TELEMETRY_URL` to send nothing. Nothing is sent at setup. See [Privacy](https://github.com/midego1/kite/blob/main/docs/privacy.md#usage-statistics-opt-in).
- **Summarize** in the reader: the sparkles button in the toolbar summarises the conversation, and **Summarize this message** in the message's **More** menu the open message alone, as a card at the top of the reader with a short overview and up to five points (**Asks**, **Decisions**, **Dates**, **Next steps**). A summary is made only when you ask, cached and shared with everyone who can read the mailbox (read-only users of a shared mailbox may make one too), and marked "New messages since this summary" with **Summarize again** when the conversation changes. It is written in the conversation's language; when that differs from your browser's, **Translate to** your language makes a translation from the summary alone, cached next to it. Personal **Summaries** instructions under [Assistant settings](/inbox) get a summary of their own. Spam, Trash, the Screener's held mail and drafts are never summarised. Each request counts against the mailbox and install spend caps and, without model prices, the token allowance chat and Write with Kite share (now **Chat, Write with Kite and summaries** in [Admin → Agent](/agent)); an external provider needs the primary admin's opt-in. Summaries are stored and deleted with their messages (deleting one, or moving it to Spam or Trash, deletes its conversation's summaries), are not in backups, and are pruned 30 days after going out of date. Apply migration **0072** (`0072_add_ai_summaries.sql`) from the admin overview to use it.
- **All mailboxes**: with two or more mailboxes, the first entry of the mailbox selector shows the mail of every mailbox you can open in one Inbox, Starred, Snoozed, Sent, Drafts, Archive, Spam and Trash. Each email carries a label with its mailbox's name, the sidebar counts add up, your folders are grouped under their mailbox, and conversations stay within one mailbox. A **Show** list in the selector leaves mailboxes out, and your browser remembers both choices. Replies and forwards go out from the mailbox the email arrived in, a new email starts from the From you used last, and bulk actions work across mailboxes while keeping each email in its own. Read-only shared mail can't be moved or deleted there either. See [All mailboxes](https://github.com/midego1/kite/blob/main/docs/all-mailboxes.md).
- **Writing style**, off by default: turn on **Learn my writing style from mail I send** under [Assistant settings](/inbox) and Kite learns, per mailbox, how you write (length, sentences and paragraphs, greetings and sign-offs, how formally you address people, questions, exclamation marks, emoji and lists) from the mail you send from the composer yourself, never from mail Write with Kite helped write. It keeps statistics and anonymised forms only, never text, and from ten messages on tells the AI in at most 500 characters how to sound like you in chat drafts, Write with Kite and the reply drafts Kite writes on its own. Turning it on can also learn from your last 200 composer sends; the settings show exactly what Kite tells the AI, with Reset per mailbox, and turning it off deletes everything. Apply migration **0070** (`0070_add_writing_style.sql`) from the admin overview to use it.

### Changed

- AI errors now say what went wrong and what to do, the same way in the assistant chat, Write with Kite, summaries and their translations, and automatic reading: the AI took too long, the answer was cut off, the provider refused the request or had a problem (with its HTTP status), the model is unavailable or the email too long for it, the answer was not usable (and why), a spend cap or rate limit was reached, the external provider is not allowed, the assistant is off or no provider is set up, or the provider could not be reached. A **Details** disclosure shows the error code, the model, the provider and the time, **Try again** appears where it helps, and the primary admin gets a link to [Admin → Agent](/agent) for a setting that needs fixing. The provider's own error text is no longer shown in chat or stored on automatic jobs.
- Activity names why an automatic job failed or went on without the model, such as "it took too long (timeout)", instead of the provider's message.
- No user-visible changes: the bundle size check now limits how much each pull request may grow instead of a shared budget file, so open pull requests no longer conflict on it.
- The **What's new in Kite** dialog now lists changes that are already deployed but not yet part of a named release under "Unreleased changes". Releases are now made by a separate release pull request that collects these changes, so production deploys between releases keep showing the last version with the build's revision.
- Report spam always asks first, wherever it starts: the reader's toolbar, Move menu and `!` key, a selection in the list, dropping mail on Spam, a conversation's message menu and Mark as spam on the phishing warning. Cancel or Esc does nothing, and there is no "don't ask again".
- Report phishing's question now reads "Report as phishing?".
- Kite has a new look, after [Zero](https://0.email): neutral grey in place of lavender, one blue accent and the Geist typeface. The earlier lavender look stays available as **Kite classic** in [Settings → Appearance](/settings/appearance) (also a switch at the bottom of the sidebar).
- The default theme is now dark. Anyone who never picked a theme starts dark, and so does anyone who picked **Match system** before this release, because that choice was not saved until now. To switch back, choose **Light** or **Match system** under Theme in [Settings → Appearance](/settings/appearance); the choice is saved in the browser from now on.
- The mailbox sits in rounded panels beside the sidebar. The sidebar starts with your mailboxes as squares, then **New email**, the **Core** folders, a folding **Management** section (Archived, Spam, Trash) and your folders, with **Settings** and **Support** at the bottom.
- The message list has its own search field and a row of chips: **Primary** (everything), **Unread**, **Attachments** and **Starred**, plus Snoozed and, when it is on, the Screener. In the Inbox, starred mail is pinned at the top. Rows show the sender's avatar with the unread dot, the conversation size, the date and the subject; checkboxes appear once you choose **Select**.
- The open email shows the subject with the conversation's size, its dates and its people, each message as a section with **Reply** and **Forward** under it, attachments as chips, and the toolbar's actions as square buttons with **Reply all**.
- Replying no longer opens a separate window: the reply box, **Reply**, **Reply all**, **Forward** and the `r`, `a` and `f` keys open the composer under the message, with the body ready to type in. Escape closes it and keeps the draft, which the reply box picks up again; **Pop out** moves it into the floating composer. Phones keep the full-screen composer.
- Operational alerts, pending database updates and skipped DNS setups are now small notices in the sidebar above Settings (over the page on phones), instead of a bar across the top.
- The message list no longer repeats the total next to "Primary"; the pager already shows it.
- In the All mailboxes view, the mailbox label of each row now sits at the right edge of the row, under the date, instead of squeezing the subject. The subject takes the remaining width, and on a very narrow list the label shortens its own name first.
- The privacy statement in the README and the privacy page now describe the opt-in usage statistics instead of saying Kite has no telemetry.

### Fixed

- **Summarize** no longer fails on long conversations with "The AI provider could not finish this". A summary may now use up to 1,600 output tokens instead of 400, which cut off the answer for long threads (the cut-off was then reported as a provider error), and the prompt states the length limits the checks keep.
- The floating "Ask Kite AI" bubble no longer disappears while a reply is open in the reader; it hides only behind the floating composer.
- The "Kite was updated" toast and every other notice (Undo, progress, the send and undo-send bars) now follow the theme: in dark mode they are dark cards with light text and a clearly visible Reload and Undo button, instead of a white card with unreadable text.
- Notices now sit in the bottom-right corner, above the reader's reply box, instead of covering it. On phones they stay above the bottom edge.
- Self-hosted (Node) installs now report the database size to the app instead of 0.
- Money Watch no longer misses the end of a compressed PDF page when its data happens to end in a line-break byte: it now uses the length the PDF states for each stream, so the last lines of an invoice (often the total) are read.
- Moving a selection to a folder now moves only the emails from that folder's mailbox; mail from another mailbox is left where it was.
- On phones, the mailbox selector inside the menu sheet can be used again; its list opened behind the sheet and could not be tapped.

### Security

- IMAP imports no longer connect in plain text. Turning off **Use TLS** in [Settings → Import](/settings/import) used to send the source password unencrypted on port 143; the form now offers **TLS (port 993)** or **STARTTLS (port 143)**, Kite always checks the server's certificate, and a server that offers neither is refused before any password is sent. Background jobs saved with TLS off now upgrade with STARTTLS and fail with the reason if the server cannot. Imports also only connect to ports 993 and 143.
- IMAP imports limit what a source server can send (per message 36 MB on Cloudflare and 64 MB on Node, per batch 48 MB or 96 MB, 8 MB per response line, 32 MB or 200,000 lines per command) and how long a command may take (three minutes, extended while data keeps arriving at 64 KB/s or more, at most ten minutes), so a broken or hostile server can no longer fill memory or hold an import forever. A message above the limit fails the import with the reason. Server addresses written in shorthand (such as `127.1`) are checked as the address they spell.
- The guard that keeps webhooks, alert webhooks, remote images, object stores and imports off private networks now also refuses IPv6 tunnel addresses that can carry a private IPv4 address (6to4 `2002::/16`, Teredo `2001::/32`, `64:ff9b:1::/48`).

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
