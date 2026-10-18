# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [calendar versions](https://calver.org/), `YYYY.MM.DD.N`: the UTC date a release was prepared and a counter for that day's releases, starting at 0 (see [Releasing](docs/releasing.md)).

## [Unreleased]

Apply database migrations 0062 and 0063 after deploying, from the database card on the admin overview or the banner in the mailbox. 0062 adds the module switches, per-user module access, booking appointment links and the calendar search index; until it is applied, every module stays on for everyone and search finds no calendar events. 0063 adds the Money Watch tables (tracked subscriptions and their documents); until it is applied, the Subscriptions page is empty and points to the update, and Money Watch finds and records nothing. No new bindings; one new optional secret, `URLHAUS_AUTH_KEY` (see URLhaus lookups below).

### Added

- **Money Watch**, a new module for subscriptions, at [Subscriptions](/finance). Automatic reading spots receipts, invoices, renewal and trial notices, refunds and failed payments (including automatic and no-reply billing mail) and offers a card such as "Netflix $17.99/month, renews 1 Nov. Track it?" to the mailbox's reviewer only. **Track** starts tracking it or updates it from a later invoice and flags price changes, **Record it** records a credit note or refund, and **Mark urgent** flags a failed payment; nothing is stored until you click, and every change can be undone (undoing **Track** is refused once a later document was recorded for the subscription, so that document is never deleted with it; remove the subscription instead). Each subscription keeps its invoices, payments, credits and refunds with links to their mail and attachments (referenced, never copied), and the page shows upcoming renewals first, monthly and yearly totals per currency and what you paid in the last 12 months. Reminders arrive before a renewal or trial end as a notice, a count on the sidebar item and, when Calendar is on, a calendar event. **Cancel before …** opens the sender's `List-Unsubscribe` link in your browser; Kite never visits it. You can also track a subscription or add a document from any message's **More actions** menu, and ask the assistant with `list_subscriptions`. When a receipt is incomplete, Kite may ask the AI model for the missing fields within the usual limits, external-provider opt-in and spend caps, and marks what the model filled. Money Watch is on by default; the owner can turn it off under Admin → Modules, and each mailbox has its own switch in the automatic reading settings. Webhook events `finance.subscription.detected` and `finance.subscription.renewal_due`. See [Assistant: automatic reading](https://github.com/midego1/kite/blob/main/docs/assistant.md#subscriptions-money-watch).
- **Report phishing**, in an open message's **More actions** menu, in the list's **Move to** and **More** menus for selected messages, and on the phishing warning. After you confirm, Kite moves the message to Spam, learns from it more strongly than from a spam report (so the next copy of the same campaign starts with a poor reputation), blocks the sender so their next mail goes to Trash, and closes the phishing warning. Saved contacts, people you have written to and addresses on your own domains are not blocked, because a phishing message can forge them; the toast says which senders were blocked and why any were not. See [Spam protection](https://github.com/midego1/kite/blob/main/docs/spam-protection.md#report-phishing).
- Optional **URLhaus lookups**. With a free abuse.ch Auth-Key in the `URLHAUS_AUTH_KEY` secret, Kite checks incoming mail that already looks risky, from senders you have not saved or written to, against URLhaus, a public list of malware sites and files: up to five links and the SHA-256 hashes of up to three attachments, never the files. A match raises the spam score and shows on the phishing warning; a lookup that fails or takes over 3 seconds is skipped. **Admin → General → Threat lookups** shows whether lookups are on. Without the secret nothing leaves your install. See [Spam protection](https://github.com/midego1/kite/blob/main/docs/spam-protection.md#urlhaus-lookups-optional).
- **Modules** under [Admin → Modules](/modules), for the owner only: turn Calendar, Booking, Email templates, Mail import and Money Watch off for everyone, or for some users under Accounts → Permissions. A module that is off disappears from navigation, the command palette, assistant chat, MCP, webhooks and search, and its pages and API answer 404. Nothing is deleted, mailbox export always works, and paused imports continue when Mail import is turned back on. Booking needs Calendar. A change reaches other open sessions within 30 seconds. See [Modules](https://github.com/midego1/kite/blob/main/docs/modules.md).
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
- Keyboard shortcuts leave browser and system key combinations alone. A key pressed with Cmd or Ctrl (or with Alt, unless Alt types a symbol) no longer counts as the first key of a shortcut such as `g i`, so Cmd+G followed by `i` stays on the page, and Cmd+? or Ctrl+/ no longer opens the shortcuts help or the search field instead of reaching the browser. Cmd+C, Cmd+R and Cmd+F were already left to the browser. `?`, `#` and `g !` typed with Shift still work, and so do `#` and `/` typed with AltGr or Option on keyboards that need it, such as `#` on French AZERTY or a British Mac. Ported from upstream Mailflare #161.
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
