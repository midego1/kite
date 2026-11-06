# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [calendar versions](https://calver.org/), `YYYY.MM.DD.N`: the UTC date a release was prepared and a counter for that day's releases, starting at 0 (see [Releasing](docs/releasing.md)).

## [Unreleased]

## [2026.11.06.2] - 2026-11-06

### Fixed

- Forwarded messages with a large attachment, and long text files sent as attachments, now arrive instead of being refused.
- Attached messages and files sent without encoding now keep their exact contents, and quoted replies in plain-text mail wrap correctly.

## [2026.11.06.1] - 2026-11-06

### Added

- Connected accounts can now stay in step both ways: choose per account what Delete, Archive, Spam, read and star do at the provider, and what Kite does when mail is deleted or read there. Everything is off until you turn it on in [Settings → Connected accounts](/settings/connected-accounts), and nothing is ever deleted permanently.
  ![The two-way sync settings of a connected account, with a choice per action in each direction](/changelog/2026-11-06-two-way-sync-light.webp)

### Changed

- This needs a database update applied from the Admin overview before two-way sync can be turned on.

## [2026.11.06.0] - 2026-11-06

### Changed

- The pending database updates on the admin overview are now listed in words (for example "Add mailbox AI disabled at") next to the file name, above the Update database button.

  ![The admin overview listing two waiting database updates in words, with the safety backup note and the Update database button](/changelog/2026-11-06-update-database-light.webp)

## [2026.11.05.3] - 2026-11-05

### Fixed

- Assistant chats no longer forget their earlier messages when the settings of a mailbox with AI turned off change. Only turning AI off for a mailbox you can open does that now. This needs a database update applied from the [Admin overview](/admin).

## [2026.11.05.2] - 2026-11-05

### Added

- **No AI for this mailbox**: in the assistant settings, people who manage a mailbox can make Kite send nothing from it to an AI provider, for everyone. API keys, MCP and JMAP can still read it, as can an AI app using such a key. Needs a database update from the [Admin overview](/admin); see [the docs](https://github.com/midego1/kite/blob/main/docs/assistant.md#no-ai-for-this-mailbox).
  ![The assistant settings with No AI for this mailbox switched on and what it turns off](/changelog/2026-11-05-mailbox-no-ai.webp)

## [2026.11.05.1] - 2026-11-05

### Added

- [Settings → Import](/settings/import) now shows how big each folder of an account is and, under the list, the totals: how many messages, how much mail that is, and how much the import adds to mail storage and to the database. Kite measures the sizes while you look, so you can start the import at any time.
  ![The folder list of a whole-account import with each folder's size and the totals the import adds](/changelog/2026-11-05-import-sizes-light.webp)
- When you connect an account you can choose **New mailbox for this account**. Kite suggests a name from the address (jane.demo@example.test becomes jane.demo-example), creates the mailbox and connects the account to it. If connecting fails, Kite tells you which mailbox it made and lets you use it again or delete it.
  ![The Connect an account dialog with a new mailbox name filled in](/changelog/2026-11-05-new-mailbox-light.webp)
- Importing mail from a connected account now starts in the mailbox that account's mail goes to.

### Fixed

- The import's estimate of mail storage no longer counts every attachment twice: imported mail takes about as much space as the mail itself. The database warning also uses the real folder sizes instead of a guess.

## [2026.11.05.0] - 2026-11-05

### Changed

- The page count and arrows in the message list now sit on the same row as the first heading, such as Primary, so the list has more room for mail. They stay in view while you scroll.
  ![The Inbox list with "1 - 25 of 35" and the arrows on the Primary row](/changelog/2026-11-05-list-pager-inline.webp)

## [2026.11.04.5] - 2026-11-04

### Added

- The account menu has a Direction setting. Choose Right to left and the menu, panes, composer, assistant, notices and resize handles all mirror, and dates and sizes keep their order. Automatic stays left to right until Kite is translated, and your choice follows your account to your other devices.
  ![Kite in right to left, with the menu on the right, the message list beside it and an Arabic message open on the left](/changelog/2026-11-04-rtl-interface-light.webp)
  ![The same view in the dark theme](/changelog/2026-11-04-rtl-interface-dark.webp)

## [2026.11.04.4] - 2026-11-04

### Fixed

- When you reopen a draft and change From, your choice now stays and the message is sent from that address. Before, Kite could switch it back to the draft's own mailbox.
- Reopening a draft no longer adds a second copy of the signature, and changing the text direction of a line in your signature no longer leaves the old signature behind when you switch From.
- A reply or draft you are writing now stays in its own mailbox when you switch mailbox in the sidebar. A draft written by the assistant stays in its mailbox, and Kite tells you when a draft cannot be saved.

## [2026.11.04.3] - 2026-11-04

### Added

- Arabic, Hebrew and other right-to-left text now reads the right way in the composer: each paragraph and the subject follow their own text as you type, and the message goes out that way. A new toolbar button switches a paragraph between automatic, right to left and left to right.
  ![The composer with an Arabic paragraph running right to left above an English one, and the paragraph direction button in the toolbar](/changelog/2026-11-04-rtl-composer-light.webp)
  ![The same composer in dark mode](/changelog/2026-11-04-rtl-composer-dark.webp)

## [2026.11.04.2] - 2026-11-04

### Changed

- Mail in Arabic, Hebrew, Persian and Urdu now reads right to left in the list, the reader, print, search and the assistant's cards, even though Kite itself stays in English. Mail that declares its own direction keeps it, and English mail that starts with a right-to-left word may now read right to left.
  ![An Arabic message open in the reader, with its sender, subject and text running right to left](/changelog/2026-11-04-rtl-message-light.webp)
  ![The same Arabic message in dark mode](/changelog/2026-11-04-rtl-message-dark.webp)

## [2026.11.04.1] - 2026-11-04

### Fixed

- On the home page, Back after denying an example email no longer reopens it, denying the only search result or starred email shows the welcome email instead of a blank reader, and the Copy prompt button goes back to its label after a few seconds and says when copying failed.
- On an unfolded foldable the bottom tab bar now stays while a message is open next to its list, and the Money Watch tab is named in full for screen readers.

## [2026.11.04.0] - 2026-11-04

### Changed

- On the home page, the comparison is now a table with its columns side by side whenever the reading pane is wide enough, and stays in stacked blocks on phones and narrow panes. The Inbox also has four clearly marked example emails, with a drafted reply, a new sender and attachments, so you can see an inbox in use.
  ![The home page Inbox with an example email open](/changelog/2026-11-03-home-examples.webp)

## [2026.11.03.0] - 2026-11-03

### Changed

- The public home page is now the mailbox itself. The page does not scroll: the folders on the left are the navigation, and each email is a part of what used to be a long page, from the Welcome email to deploy, cost, comparison, limits and the questions. Light and dark follow your theme, and a sun and moon button switches it.
  ![The new home page: a mailbox with the Welcome email open](/changelog/2026-11-02-home-page.webp)

## [2026.11.02.3] - 2026-11-02

### Added

- On a phone, a tab bar at the bottom now switches between Mail, Calendar, Drive and Money Watch, with More opening the full menu. It steps aside while you read a message or write one, and the sidebar returns on wider screens.
  ![The phone tab bar under the inbox](/changelog/2026-11-02-mobile-tab-bar-light.webp)

### Changed

- The home page now leads with what you get, what sending costs, how this inbox compares with the earlier version, and what the early beta still lacks. Deploy is five steps, with the Docker command beside it.
  ![The home page hero and the live inbox demo](/changelog/2026-11-02-home-landing.webp)

## [2026.11.02.2] - 2026-11-02

### Added

- Foldable phones and tablets now show one pane when folded and the list beside the reader when unfolded, and the layout follows a fold or unfold while a message is open.
  ![An unfolded tablet showing the message list beside the open message in light mode](/changelog/2026-11-02-fold-two-panes-light.webp)
  ![An unfolded tablet showing the message list beside the open message in dark mode](/changelog/2026-11-02-fold-two-panes-dark.webp)
- Settings → Appearance → Fold layout can force a single pane or two panes on any device.

## [2026.11.02.1] - 2026-11-02

### Changed

- Calendar and Bookings now sit in the same frame as the rest of Kite, with the mail menu in the sidebar. The upcoming events are a panel beside the calendar that you can fold away to give the week more room.
  ![Calendar in the app frame in light mode](/changelog/2026-11-02-calendar-frame-light.webp)
  ![Calendar in the app frame in dark mode](/changelog/2026-11-02-calendar-frame-dark.webp)
- Drive's views (My Drive, Recent, Shared with me, All attachments, Trash) are a menu beside the file list, with the storage you have used at its foot; the sidebar stays the mail menu.
  ![Drive in the app frame in light mode](/changelog/2026-11-02-drive-frame-light.webp)
  ![Drive in the app frame in dark mode](/changelog/2026-11-02-drive-frame-dark.webp)
- The notices in the sidebar (operational alerts, database updates, DNS setup, connected accounts) are the same notices as on the pages, at a smaller size, and the cards on the Admin overview carry the same small icon and title as the cards in the empty reading pane.
  ![The admin overview's cards in light mode](/changelog/2026-11-02-admin-cards-light.webp)
  ![The admin overview's cards in dark mode](/changelog/2026-11-02-admin-cards-dark.webp)
- Admin → Accounts and Settings → Connected accounts list their accounts the same way: the name with a badge for the role or the status, and the address under it.
  ![Admin → Accounts in light mode](/changelog/2026-11-02-account-rows-light.webp)
  ![Admin → Accounts in dark mode](/changelog/2026-11-02-account-rows-dark.webp)
- The filter chips over the mail list (Primary, Unread, Attachments, Starred) and over Drive's files (Photos, Videos, Documents, Others) look the same now: a chip that is on gets the light tint the sidebar uses for the current page, instead of a solid colour.
  ![The mail list's chips in light mode](/changelog/2026-11-02-list-chips-light.webp)
  ![The mail list's chips in dark mode](/changelog/2026-11-02-list-chips-dark.webp)
- Drive's column labels are the plain muted labels the rest of Kite uses, and a Drive view with nothing in it shows the same empty state as For you and Money Watch, with a line on what appears there.
  ![An empty Drive view in light mode](/changelog/2026-11-02-drive-empty-light.webp)
  ![An empty Drive view in dark mode](/changelog/2026-11-02-drive-empty-dark.webp)

## [2026.11.02.0] - 2026-11-02

### Added

- Release notes in **What's new in Kite** can now show screenshots: click a thumbnail to enlarge it. **Show images** in the dialog's header turns the thumbnails off.
  ![The What's new dialog with two thumbnails under the command center release, and the Show images switch in its header](/changelog/2026-11-02-whats-new-images.webp)
- With full access to the mailbox, you can rename or delete a folder from its **⋯** menu in the sidebar. Deleting asks whether its messages go to **Archive** or **Inbox**, and turns off inbox rules that filed mail into it.

## [2026.11.01.5] - 2026-11-01

### Fixed

- If Kite gets stuck on the loading screen, it now recovers by itself: it first retries the stuck step, then reloads the tab once. If it stalls again, you see "Kite couldn't load" with a **Reload** button.
- Even when the page's script has stopped completely, Kite now reloads a frozen loading screen after 10 seconds. Hidden tabs are never reloaded, and the details of the reloaded start say it happened automatically.

## [2026.11.01.4] - 2026-11-01

### Changed

- The command palette (Cmd/Ctrl+K) now searches the whole app: pages, messages, contacts, actions, settings and the modules you have on. Results are grouped by category, show a badge, a short subtitle and the keyboard shortcut, and you can use Alt+1 to 9, the arrow keys, Enter and Esc to move around. On phones it fills the screen.
  ![The command palette searching for "re", with categories on the left and results on the right](/changelog/2026-11-01-command-palette.webp)

## [2026.11.01.3] - 2026-11-01

### Fixed

- Sending now closes the composer, like in Gmail. The "Sending in …s" bar with **Send now** and **Undo** stays visible, and **Undo** reopens your message with everything in it.
- The send bar and other notices no longer cover an open composer, and on a phone the bar now fits the screen.

## [2026.11.01.2] - 2026-11-01

### Changed

- The command center in the empty reading pane is laid out as cards again. Unread, Screener and For you are tiles that open their page, and **Accounts**, **Quick actions**, **Needs attention**, Calendar's **Today** and Money Watch's renewals are cards that sit side by side or stacked, depending on the width of the pane.
  ![The command center in light mode: unread and Screener tiles, Accounts, Quick actions, Needs attention, Today and Money Watch cards](/changelog/2026-11-01-command-center-light.webp)
  ![The same command center in dark mode](/changelog/2026-11-01-command-center-dark.webp)

## [2026.11.01.1] - 2026-11-01

### Changed

- The command center's **Quick actions** are tiles again, styled like the sidebar's **New email** button, with the shortcut key shown at the right.

## [2026.11.01.0] - 2026-11-01

### Changed

- The command center in the empty reading pane now looks like the rest of Kite: small group labels over plain rows, the same notices as the [Admin overview](/admin) under **Needs attention**, and no extra cards or glow. The greeting ("Good morning," and so on) now shows in every style.

### Fixed

- The message list now always scrolls inside its own panel, so a folder with lots of mail no longer stretches the page.

## [2026.10.31.11] - 2026-10-31

### Changed

- The recovery runbook now has one section on rolling back and restoring backups when attachments are shared or served from the raw message. After restoring a backup taken before a reclaim, choose **Reclaim space** again. See [Attachment storage: rollbacks and restores](https://github.com/midego1/kite/blob/main/docs/runbooks/recovery.md#attachment-storage-rollbacks-and-restores).

### Fixed

- Files in received or imported mail no longer stay missing after an older Kite release restored a newer backup. Once the database update is applied, Kite finds such a file in the stored message the next time it is opened, and **Restore separate copies** under [Admin → Storage](/storage) now includes these files too.
- **Why?** for failed AI requests on the [Admin overview](/admin) no longer says Ask AI "would fail the same way" after you saved or switched the AI provider in [Admin → Agent](/agent#ai-provider). Failures from before the change no longer count.
- A question **Ask AI** prepared for the assistant is dropped after five minutes if the assistant never took it. Closing the Why? dialog returns the keyboard focus to **Why?**.
- The text on the command center's cards is now easier to read in every style and theme, and information notices under **Needs attention** use a calmer blue in Classic light.

## [2026.10.31.10] - 2026-10-31

### Added

- [Admin → Storage](/storage) has a new **Attachment storage** card for the primary admin. It shows how much space older mail could free, and **Reclaim space** frees it while **Restore separate copies** undoes that; both run in the background and can be stopped. Files download exactly as before. This needs a database update applied from the Admin overview. **Reclaim space** is unavailable while `ATTACHMENT_RAW_INDEX=off`.

### Changed

- Rolling back to a release before 2026.10.31.3 now has one procedure: set `ATTACHMENT_SHARING=off` and `ATTACHMENT_RAW_INDEX=off`, deploy, choose **Restore separate copies**, wait until nothing is served from the raw message or shared, then roll back. See [Materialize, then roll back](https://github.com/midego1/kite/blob/main/docs/runbooks/recovery.md#materialize-then-roll-back).

### Fixed

- **Ask AI** for failed AI requests on the [Admin overview](/admin) no longer leaves out cut-off failures on a busy day, and its summary no longer cuts a group off half-way.

## [2026.10.31.9] - 2026-10-31

### Added

- **Why?** next to "N AI requests failed in the last 24 hours" on the [Admin overview](/admin) and in the mailbox's command center (primary admin) groups the failures by cause, with the likely reason and a link to the setting that fixes it. **Ask AI** opens the assistant with that summary ready to send, without any email content.

### Changed

- Files in received and imported mail are no longer stored twice, so a message with attachments takes about a third less storage. Everything works as before, and self-hosters can turn this off with `ATTACHMENT_RAW_INDEX=off`.
- **Do not roll back to a release before 2026.10.31.3 once this one has run**, because those releases show files served from the raw message as missing. Fix forward instead, or follow the [recovery runbook](https://github.com/midego1/kite/blob/main/docs/runbooks/recovery.md#rolling-back-past-raw-backed-attachments) first. The earlier warning about rolling back past attachment sharing still applies.
- **Why?** for cut-off failures on the [Admin overview](/admin) now explains what happened and which setting to change. **Ask AI** sends the same facts, so the assistant can answer instead of guessing. Still no email content.
- The command center in the empty reading pane now looks calm in every style and theme. Its cards are quiet and a warning under **Needs attention** is one amber callout, instead of the solid blocks Kite classic showed in dark mode.
- The switch is now called **Allow an external AI provider to read mail** in [Admin → Agent](/agent), and its description lists every feature it covers.
- If the primary admin has not turned on **Allow an external AI provider to read mail** in [Admin → Agent](/agent#automatic-reading), the older **Automatically draft replies** setting no longer fills Activity with skipped drafts. The assistant guide also now says that a custom endpoint you run yourself counts as external.
- Reloading after an update no longer shows the kite's return. The page just reloads like an ordinary refresh.

### Fixed

- Automatic reading with Anthropic's Claude Haiku 5.5 and other Claude 5 models no longer fails with "The AI's answer was cut off". Kite now turns off thinking for automatic requests, drafts, summaries and Write with Kite unless you saved a reasoning effort in [Admin → Agent](/agent), and a cut-off answer is retried once with more room.
- If the page freezes while starting, the loading screen now says "Kite stopped responding. Reload this page to start again." after 10 seconds.
- After a freeze while starting, the next load reports how far it got, with no message content or addresses, so the cause can be found.

### Security

- The primary admin's external-provider opt-in now also covers the assistant chat and the older **Automatically draft replies** setting. With an external provider and the opt-in off, the assistant panel explains why chat is off and automatic drafts are skipped. **If your install uses an external provider for chat, the primary admin has to turn on the opt-in once for chat to keep working.**

## [2026.10.31.8] - 2026-10-31

### Added

- Admins can now ask for a report of how many attachments and stored files there are, and check that the newest 200 stored files still exist.

### Changed

- **Do not roll back to an older release once this one has run.** Older releases delete an attachment's file together with its message, even if another message still uses it. Fix forward instead. If a rollback cannot be avoided, follow the [recovery runbook](https://github.com/midego1/kite/blob/main/docs/runbooks/recovery.md#rolling-back-past-attachment-sharing) first. Self-hosters can turn off new sharing with `ATTACHMENT_SHARING=off`; it is on by default. A backup taken after this release can only be restored into a database that has the matching database update applied.
- Sending a draft and forwarding a message no longer store their attachments a second time, so each file is kept once. Deleting a message removes a file only when nothing else uses it, and a storage failure can leave an unused file behind but never a message with a missing attachment.
- The command center's **Today** and **Money Watch** cards now sit below the quick actions, so nothing you are about to click moves. They also stop reloading every time you close a message.

### Fixed

- A trial whose payment failed now shows as **Payment failed** in the Money Watch card and in the search dropdown, and counts in the Subscriptions sidebar count.
- An event that started yesterday and runs into today now opens on today in the Calendar when you choose it in the **Today** card.

## [2026.10.31.7] - 2026-10-31

### Added

- The command center in the empty reading pane now shows a **Today** card with what is left on today's calendar, and a **Money Watch** card with subscriptions that renew, end a trial or failed a payment this week. Each card appears only while its module is on for you. Modules can add cards like these ([Modules](/modules)).

### Fixed

- After you switch accounts, the For you suggestions on screen now load for the new account right away.
- When the green **Database updated** notice goes away while it has the keyboard focus, the focus now moves to a nearby element that can take it.

## [2026.10.31.6] - 2026-10-31

### Added

- When no message is open, the reading pane now shows a small command center: a greeting, your unread, Screener and For you counts, your connected accounts with their status (a failed sign-in gets a Reconnect link), and quick actions. Administrators also see what needs attention, like waiting database updates and backup health.

### Changed

- **What's new in Kite** now loads its notes only when you open it, so the app downloads less.

### Fixed

- A reading layout you pick while your account's layout is still loading is no longer lost. Turning off **Use the same layout on every device** in [Settings → Inbox](/settings/inbox) in that moment keeps this browser's layout, and signing in to another account no longer holds back its saved layout.
- Dismissing the green **Database updated** notice with the keyboard now moves focus somewhere sensible, and the notice no longer disappears while you are in another window.
- After you open an older message of a conversation from a link and move it away, focus goes to the next conversation in the list.
- For you suggestions in the sidebar and the reading pane refresh faster, and they no longer stay empty when a list opens right after you switch accounts.

## [2026.10.31.5] - 2026-10-31

### Changed

- "Kite was updated" at the top of a message list now looks like a message from Kite, with the new release's notes as its body and **Reload** and **Dismiss** buttons. It is not a real message, so it is never counted, selected or moved.

## [2026.10.31.4] - 2026-10-31

### Added

- Connected accounts can now send from addresses their sign-in does not prove, such as an **Other IMAP provider** account's own address or a provider alias. In [Settings → Connected accounts](/settings/connected-accounts), use **Verify** or **Send from another address** to get a 6-digit code by email. Once you enter it, the address shows up in the composer's From menu. This needs a database update applied from the Admin overview.
- You can print an email from the reader's ⋯ menu, or with Ctrl/Cmd+P. You get a clean page with the headers, attachment names and the full body. In conversation view you can print the whole conversation or a single message.
- **Download PDF** in the same menus saves the email or conversation as a PDF named after the subject. It holds text only and Western European characters. For images or other scripts, use Print and choose Save as PDF.

### Changed

- An unverified connected address now shows in the From menu as **(Verify in Settings)** instead of being left out. Connecting or testing an account also checks its SMTP sign-in when its user name is not its address.
- The green **Database updated** notice now fades away by itself after about eight seconds, as a tiny kite lifts off its corner. It waits while you are pointing at it, and there is a new **Dismiss** button to close it at once. The notices about updates still waiting or a failed run stay until you deal with them.
- The inbox preview on the landing page is now a live demo you can click through, with invented data. You can open messages, switch folders, archive, snooze, star, search, try a drafted reply and chat with Kite AI. It works with the keyboard and on a phone.
- The loading screen now shows what Kite is doing: its five start-up steps, filled in with facts like your account name, whether the database is up to date, and how long the start took.

### Fixed

- **Report spam** in the reader now moves the whole conversation out of the list in conversation view. Before, it only reported the open message and the rest stayed in the Inbox. Report phishing, Archive, Move to trash, Not spam, Move to a folder and Block contact in the reader's toolbar now work the same way.
- The reader now closes right away and focus moves to the next row when the open message leaves the list, whether you trash, archive, move, report or snooze it. Before, it kept showing the message until the move finished, which could look stuck on a busy install. **Undo** puts the message back.
- A reading layout you pick while your layout could not be loaded (a slow first request after an update, or a dropped connection) is no longer lost. Kite tries again a few times and saves your choice once it can.
- The automatic direct-upload setup under [Admin → Storage](/storage) now says it took too long when it ran out of time, instead of saying the checks failed. It also cleans up a token Cloudflare created late.
- Very long emails are no longer searched for a one-time code when they arrive, so their new-mail notification never shows one.

## [2026.10.31.3] - 2026-10-31

### Changed

- Kite is preparing to store each mail attachment only once. This needs a database update applied from the Admin overview. Nothing is converted yet and attachments download as before, even while the update is waiting.

### Fixed

- On the self-hosted (Node/Docker) version, reading just part of a stored file, such as the check of a risky ZIP attachment, no longer loads the whole file into memory first.

## [2026.10.31.2] - 2026-10-31

### Added

- The "Reload Kite" and "Kite couldn't load" screens now have a folded **Details** section with **Copy details**, to help with bug reports about a start that hangs. It never includes message content or addresses.
- [Settings → Connected accounts](/settings/connected-accounts) has a forwarding guide for Gmail, Outlook.com and Microsoft 365, iCloud Mail, Yahoo Mail, Fastmail and other providers, with your Kite address filled in. Choosing Outlook.com or Microsoft 365, which Kite cannot connect yet, now offers **Set up forwarding**.
- Mail that came in through a connected account, or was sent as one, now shows a "via" chip such as "via Gmail" in the list and reader. Click it to see everything from that account, or search with `via:` to find mail by provider, address, label or domain.
- **Also sync the Spam folder** on a connected account (off by default) also checks the provider's Spam folder. That mail always lands in Kite's Spam, where Kite's own spam filter still runs on it.

### Fixed

- A loading screen that keeps restarting now gives up with "Kite couldn't load" after 30 seconds of being visible. "Startup is taking longer than expected" no longer appears the moment you switch to a tab that loaded in the background.
- Some messages could freeze the browser for a few seconds when opened, listed or replied to, such as ones with very long runs of dashes or dots, or conversations with thousands of people. They now open quickly, and long runs of broken characters in incoming mail no longer hold up the mail queue.
- Opening a large email, or reloading Kite while one is open, no longer freezes the page behind the loading screen.

## [2026.10.31.1] - 2026-10-31

### Added

- While a send is held by the undo window, the bar now shows a **Send now** button next to **Undo**, a countdown, and a link to the queued message in Sent. A message is never both sent and undone. If the provider refuses it, the bar says "Sending failed" and offers Edit. Sends waiting for a connected account's retry cannot be hurried.
- Avatars that have loaded once no longer flash a blurred preview on your next visit.

### Changed

- The self-hosted (Node/Docker) server now also loads remote images for you instead of letting the browser fetch them, and refuses private and reserved addresses, like the Cloudflare version.
- Activity's list of assistant tool calls, and the cleanup of old ones, is faster on a large log. This needs a database update applied from the [Admin overview](/admin), and everything works as before until then.
- The collapsed sidebar now tints a folder with any colour you picked, the default blue included. Folders nobody coloured stay neutral, like the system folders. This needs a database update applied from the [Admin overview](/admin). Until then, a folder you picked blue for shows as neutral.
- The landing page now describes today's Kite. It has a hero with an inbox preview, a feature overview, a "How it runs" section, and ways in: **Deploy to Cloudflare**, **Self-host with Docker**, **Sign in** and the source on GitHub. Signed-in people get **Open dashboard**. It follows the light and dark theme and fits a phone.

### Fixed

- Reloading to a new version can no longer leave Kite stuck on the loading screen. A loading screen still up after 30 seconds now shows "Kite couldn't load" with a Reload button. A refresh or an automatic reload shows the plain loading screen.
- The composer's message body now fills the whole composer, so clicking anywhere below the text puts the cursor in it.
- A new version is picked up on the next load, because the browser no longer holds on to an old copy of the notification service.
- Being signed out when Kite reloads to a new version no longer shows the kite's return on the sign-in page.

### Security

- Risky attachments, such as programs, scripts, installers, macro files, disguised names like `invoice.pdf.exe`, web pages, disk images and archives, are now flagged. Their download waits until you confirm with **I understand the risk**. Kite still has no antivirus.
- Attachment file names are cleaned before they are stored, and a sender's file name never becomes part of a storage path. Download headers also drop unsafe characters and cap long names.
- A large-attachment download link stops working while its message is in Trash, Spam or the Screener, or while its mailbox or owner is disabled.
- **Insert link** in the composer can no longer be used to inject markup through the address.
- Kite's pages now keep windows it opens, or that open it, from getting a handle on each other.
- Webhooks, mail import, object storage and the remote image proxy now refuse host names that hide a private address (like `10-0-0-1.example.com`) and wildcard DNS services such as `nip.io`.
- A received reply now joins a conversation only if it passed the sender domain's DMARC check, or DMARC gave no result and the sender is already part of that conversation. A stranger who learned a Message-ID can no longer slip a message into a conversation. Conversations no longer show Spam unless you open that message.
- Received mail no longer renames a contact. Messages show the name you saved for the contact, else that message's own From name, so a shared no-reply address keeps a different sender per message.
- The loop guard for forwarded mail is now signed per message, so a sender can no longer switch off your account forwarding for its message. Installs without `APP_ENCRYPTION_KEY` set keep the old unsigned guard, so set it to get the signed version (see [The forwarding loop guard](https://github.com/midego1/kite/blob/main/docs/sending-and-deliverability.md#the-forwarding-loop-guard)). Two installs forwarding to each other now stop after one extra hop.
- New-mail notifications now show the sender as "Name <address>" without hidden control characters, and mail filed in Trash by a rule or a block no longer notifies, like Spam.
- Senders first seen in Spam, Trash or the Screener, or first recorded by blocking them, are no longer looked up on Gravatar.
- The new-message webhook is no longer sent for mail filed in Spam or Trash. Mail held by the Screener still sends it.

## [2026.10.31.0] - 2026-10-31

### Added

- Setup on Cloudflare can now turn on fast direct Drive uploads for you. To allow it, add the permissions **Workers R2 Storage: Edit** and **Account API Tokens: Edit** to your Cloudflare token (see [Direct uploads at setup](https://github.com/midego1/kite/blob/main/docs/deployment.md#direct-uploads-at-setup)). You can remove the second one after setup, and if the automatic step fails, setup still finishes.
- [Admin → Storage](/storage) and the [Admin overview](/admin) show a reminder, "Direct uploads are off: set up (2 min)", with the reason the automatic setup failed. **Enable direct uploads** now starts with **Set up automatically**, which does it in one click and names any missing permission.
- Kite remembers the result of the automatic setup and whether you dismissed the reminder. This needs a database update applied from the [Admin overview](/admin); until then the reminder shows without a reason and **Dismiss** has to wait.
- **Add store** with Cloudflare R2 can now create a new bucket or connect one of your existing buckets in one click, and shows each step as it goes. If the name is taken, it offers to connect the existing bucket, and if setup fails it puts things back as they were.

### Changed

- The [Admin overview](/admin) now starts with what needs your attention, such as waiting database updates, backup problems, failed webhooks, failed AI requests or domains that are not active yet, each with a link to fix it. Tiles below count accounts, mailboxes and domains, and admins who are not the primary admin see the same overview for what they may read.
- Kite no longer follows redirects when talking to a saved store. If your store sits behind a proxy that redirects, save it with its final address.
- Every **Test connection** attempt is now recorded in the audit log with its outcome, including attempts refused for trying too often.
- A forwarded message attached inside another email, and each post of a digest, now shows as an attached .eml file instead of being merged into the body. Attached messages no longer count toward the limit of 10 attachments.
- After you upgrade, the daily clean-up now also goes through existing raw mail in the Mail store (up to 20,000 files a day) and deletes raw copies older than a week that no message uses. Raw mail of stored messages is never touched (see [Inbound mail limits](https://github.com/midego1/kite/blob/main/docs/operations.md#inbound-mail-limits)).

### Fixed

- Messages with a very large body, subject, address list or Message-ID are now saved instead of being lost after failing. Large HTML bodies go to mail storage and other oversized fields are shortened.
- Two first messages from the same new sender arriving at the same moment no longer make one of them fail.
- Mail for an address that has no mailbox, alias or catch-all is now refused with "No such recipient here" instead of being stored and silently dropped. If the lookup itself fails, the message is still stored so nothing is lost.
- Raw mail that nothing stores is now cleaned up, and a daily sweep removes leftovers after a week. A message whose forward failed now goes to the rule's mailbox or stays in mail storage instead of being dropped.
- When the database is briefly unavailable, incoming mail is now kept for processing even with account forwarding set up, instead of being refused.

### Security

- The Cloudflare permission **Account API Tokens: Edit** is powerful: with it, a leaked token could take over the Cloudflare account. Only add it for the automatic setup and remove it afterwards, as the docs and the dialog say. Kite never stores or shows the token value, and tokens it created for a bucket stay in your Cloudflare account until you delete them there.
- Incoming mail is now checked before it is read, so a crafted message (a huge header block, thousands of parts, deep nesting or endless short lines) is refused instead of overloading the server. Every way mail comes in uses the same check.
- Turning HTML into text for previews, search and automatic reading no longer slows down on badly formed emails.
- Plain-text messages that use flowed formatting are now read much faster. A very large one that took about 25 seconds now takes well under one.
- Mail from Resend now keeps its normal headers, so auto-replies, mailbox rules and automatic reading recognise automatic and list mail there too.

## [2026.10.30.4] - 2026-10-30

### Added

- In [Admin → Storage](/storage), **Test connection** in the Add store, Edit store and Enable direct uploads dialogs now runs every check without saving. It lists what passed or failed with a fix in the provider's own words, and a missing CORS rule comes with the rule to copy.
- The store form is now grouped into Where, Credentials and Direct uploads, with presets for Cloudflare R2, Amazon S3, Backblaze B2, Wasabi and Hetzner. Each preset links to the page where you create keys, the secret has a show and hide toggle, and mistakes are explained under the field.
- **Enable direct uploads** for the default R2 bucket is now a four-step guide, and the Storage page and [Drive settings](/drive/settings) recommend it while uploads still go through the Worker.
- After you click **Reload** in the "Kite was updated" notice, the loading screen now shows the kite flying back in and floating above the progress bar until the new version is ready. It follows your theme, and browsers set to reduced motion see a still kite with "Updating Kite…".

### Changed

- The Admin menu is now grouped by task: Overview, People, Mail, AI, Modules, Data and System. Every address stays the same, and page titles now match the menu.
- The dyslexia-friendly font now has a **Use it for** choice under [Settings → Appearance](/settings/appearance). **Text only** (the new default) uses it for emails and what you write while menus and buttons keep the normal font, and **Everywhere** is how it worked before. If you already chose it, pick Everywhere to keep the whole app in it.
- A saved store's checks now fold into "All N checks passed" with **Show details** when nothing failed, and the **Switch** button under Where data lives explains why it is unavailable.
- A refused access key or secret now says which one is wrong and why, such as a stray space or the wrong length.

### Fixed

- Applying database updates holds up better on slow or unreliable connections, and other open tabs show the busy state reliably.
- Dark mode no longer leaves dark text unreadable in mail with its own colours, and no longer turns ordinary replies into inverted cards. Where dark mode changed a message, **Original colours** is now offered above it, at every width, and also restores its quoted history.

### Security

- The assistant, automatic reading, automatic reply drafts and conversation summaries no longer read Spam, Trash, mail held by the Screener or other users' drafts, so text from an unapproved sender cannot steer them.
- Sending a draft the AI assistant wrote through JMAP now requires you to review and confirm it in Kite first, as the composer already did.
- In assistant chat, changing or deleting calendar events is now a proposal you approve under the answer. Nothing changes before you click, and the approval is refused if the event was edited in the meantime.
- Sending an AI draft now tells you the assistant wrote it and warns about recipients you have never written to. Auto-replies, invitation answers, booking notices and cancelled sends no longer add recipients to your contacts or approve them in the Screener.
- The MCP server now tells clients that mail and calendar content is untrusted, labels read-only and destructive tools, and records each tool call (never its content) in the audit log for 90 days.
- Mail that fails DMARC from a domain that asks for rejection or quarantine now goes to Spam, even from a saved contact. Mail that fails both SPF and DKIM with no DMARC result goes to Spam too, while a failure from a domain with `p=none` only adds to the spam score. A failed check also stops a known sender from being trusted automatically, so a forged sender no longer reaches the Inbox. Forwarded mail that still passes DMARC keeps its trust.
- A new switch, **Treat every DMARC failure as spam**, under [Admin → General](/general) in Sender authentication is off by default. It needs a database update applied from the Admin overview.
- Self-hosted: the built-in SMTP listener now checks SPF, DKIM and DMARC itself, so the spam filter and the rules above apply to mail received on port 25. It also adds limits on sessions, recipients and idle time. It needs to see senders' real addresses, see [Self-hosting](https://github.com/midego1/kite/blob/main/docs/self-hosting.md#receiving-mail).
- Editing a store's address, bucket, region or provider now asks for its access keys again, because saved keys only ever work for where they were saved. Storage checks also no longer follow redirects and give up after 15 seconds.

## [2026.10.30.3] - 2026-10-30

### Added

- A dyslexia-friendly font. Under [Settings → Appearance](/settings/appearance), **Font** now offers **Dyslexia-friendly (OpenDyslexic)**, with a little more room between letters, words and lines, and **Font in HTML emails** can use it for HTML emails too. The font files are only loaded while it is chosen.
- The people in a conversation's header are now buttons. Hovering shows their full address, and clicking opens a small contact card to copy the address, write a new email, search the Inbox for their mail, add or edit the contact, or block them. Your own address says "You". The sender's name in the message opens the same card.
- **Reload** in the "Kite was updated" notice now sends the kite off: the logo lifts off the page and sways out of view while the new version loads. Browsers set to reduced motion reload at once.

### Changed

- Your **Font** choice and **Font in HTML emails** now follow your account to your other devices while **Use the same layout on every device** is on.
- Searching "from:" with a whole email address now matches that sender exactly instead of any address with the same words.
- Settings is now grouped into Account, Mail, Integrations and Data. Sending, the signature and automatic replies moved to a new [Settings → Composing](/settings/composing) page, and browser notifications to [Settings → Notifications](/settings/notifications). Old addresses still work, and settings rows look the same across pages.
- [Settings → My account](/settings/account) is now one card, [Settings → Appearance](/settings/appearance) separates the look from the assistant's display choices, and [Settings → Security](/settings/security) uses the same card layout. The Screener's "Mail from new senders" choice on [Settings → Inbox](/settings/inbox) is now two side-by-side options.
- [Settings → Import](/settings/import) shows what to import as a list of checkboxes, [Settings → Export](/settings/export) names the mailbox it exports, and [Settings → App passwords](/settings/app-passwords), [Settings → API keys](/settings/api-keys) and [Settings → Rules & routing](/settings/rules) have a tidier look, with a clearer empty state for rules.
- **"Kite was updated"** now appears as the first row of your message list, with a **Reload** button and a close button, instead of a toast in the corner. Pages without a message list, such as Settings, still show the toast.

### Fixed

- Applying database updates no longer looks like the page has hung. The button shows "Updating database…" with the steps, a progress bar and a timer, and the browser warns you before you leave the page. When it finishes you see how many updates were applied and whether a safety backup was saved.
- The collapsed sidebar is now neatly aligned: every item is the same size, the active item looks like a hovered one, and the unread count sits on the corner without covering the icon.
- The Drive sidebar's collapsed rail now matches the mail rail, also in a narrow window, and the sidebar's fade shows only while the list is long enough to scroll.

## [2026.10.30.2] - 2026-10-30

### Added

- **New mail from connected accounts.** Kite now checks each [connected account](/settings/connected-accounts)'s Inbox every 5 minutes (or every 15 or 60, per account) and delivers new mail like any other, with the spam filter, rules, Screener and notifications. Nothing at the provider is changed. **Check now**, **Pause**/**Resume** and the interval are on each account, and a failed sign-in shows there with **Reconnect**.

### Changed

- An **Other IMAP provider** account no longer claims its address for the whole install, because its own server cannot prove the address, and connecting one never says whether the address is already connected elsewhere. This needs a database update applied from the Admin overview.

### Fixed

- A restore no longer fails when a message belongs to a connected account that the backup does not contain. The message is restored without it.

## [2026.10.30.1] - 2026-10-30

### Changed

- The reader toolbar is tidier: the close button and the unread counter are gone, and the button that hides or shows the email list now sits at the far left. On a phone or in a single column, the same spot holds the Back button. Newer and older email still work with the arrows and with k and j.

## [2026.10.30.0] - 2026-10-30

### Added

- **Include mail files** under [Admin → Backups](/backups): backups can now also copy raw mail, attachments and large message bodies, and **Restore mail files** puts back any that are missing. It is off by default, the page shows how much space it takes, and deleting a backup deletes its copies too. This needs a database update applied from the [Admin overview](/admin).

### Changed

- New installs now back up daily and keep the last 14 days of backups, and existing installs keep their settings. **Delete old backups automatically** now stays visible on the Backups page while automatic backups are off, because it also removes manual and safety backups.

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
