# Connected accounts

A connected account is a mail account at another provider (Gmail, Google Workspace, iCloud Mail, Yahoo Mail, AOL Mail, Fastmail or any other IMAP provider) whose sign-in Kite keeps, so you can bring its mail into Kite without typing the password each time. By default Kite only reads from the account and never deletes, moves or marks anything there; [two-way sync](#two-way-sync) is a choice you make per account.

A connected account does three things:

- **New mail arrives in Kite.** Kite checks the account's Inbox every few minutes and delivers what arrived since you connected it into the account's mailbox (see [New mail](#new-mail)).
- **Existing mail can be imported.** **Import mail** copies the account's existing mail into Kite in the background (see [Importing a whole account](modules.md#importing-a-whole-account)).
- **You can [send as its address](#send-as-the-accounts-address)** from the composer, through the provider's own mail server. With two-way sync off that is the only thing Kite ever writes at the provider: the provider keeps the sent message, and Kite may save a copy in its Sent folder.

You do not have to connect an account to get its mail into Kite: [forwarding](#forward-mail-to-kite-instead) at the provider needs no password in Kite and delivers each message the moment it arrives. It is the way for Outlook.com, Hotmail and Microsoft 365, which cannot be connected yet.

## Connect an account

1. Open **Settings → Connected accounts** (`/settings/connected-accounts`) and choose **Connect account**.
2. Enter the account's email address. Kite recognises the provider from the address (`gmail.com`, `icloud.com`, `yahoo.co.uk`, …) or, for your own domain, from where its MX records point (Google Workspace, Microsoft 365, iCloud+ custom domains, Fastmail). Check the **Provider**, or choose **Other IMAP provider** and enter the IMAP server, port and encryption yourself, and the SMTP server if you want to send from the address (optional). With a known provider Kite signs in at that provider's own server with the address itself, so the sign-in proves the address. **Other IMAP provider** accepts a different user name, and because you name its server yourself, its sign-in proves nothing about the address (see step 6).
3. Enter the password. Most providers need an **app password** for mail apps once two-step sign-in is on; the dialog says where to make one:
   - Gmail: Google Account → Security → 2-Step Verification → App passwords. Google Workspace: the same, if your Workspace admin allows app passwords.
   - iCloud Mail: Apple Account → Sign-In and Security → App-Specific Passwords.
   - Yahoo and AOL: Account Security → Generate app password.
   - Fastmail: Settings → Privacy & Security → Manage app passwords.
4. Choose **Mail goes to**: the Kite mailbox the account's mail arrives in and is imported into. You need full access to it. If others can read that mailbox, the dialog says so: everyone with access to it will see the account's mail. If you may create mailboxes (admins, and members with the mailbox permission), the list ends with **New mailbox for this account…**: Kite suggests a name from the address and the provider (`jane@example.com` becomes `jane-example`), which you can change, on a domain you may use, and creates it first. It is an ordinary personal mailbox made through the same path as Settings → Mailboxes, with the same permissions, routing rule and limits. A name that is already a mailbox is refused before anything is created. If creating works but connecting does not (a wrong password, say), the dialog says that Kite created the mailbox and keeps it selected, so connecting again reuses it instead of making a second one; **Delete** in that notice removes it, but only while it is still empty and no account delivers into it: once mail has arrived or an account was connected to it, Kite refuses and says why. If you pick another mailbox instead, the one Kite made stays and the page tells you; closing the dialog also leaves a note on the page that it exists. People who may not create mailboxes see nothing new. Choose how often Kite should **Check for new mail**: every 5 minutes (the default), every 15 minutes or every hour.
5. Enter **your Kite password** again. Kite asks for it because it is about to store another account's password.
6. **Connect.** Kite signs in to the account and opens its Inbox read-only. Only when that works is the account saved, and Kite notes where the Inbox stands: checking for new mail starts with mail that arrives after this moment. An address at a known provider can be connected once in this Kite. That is checked only after the provider's own server accepted the password, so nobody learns whether such an address is connected without its password, and the answer never says by whom. An **Other IMAP provider** account is never checked against other accounts and does not reserve its address, because anyone can run a server that accepts any address: someone else may connect the same address, and the answer never tells whether it is connected already. Kite then also signs in to the provider's SMTP server with the same password, without sending anything; when that works, you can send as the address. When it does not, the account is still connected and its row says why sending is not available (**Test connection** tries again).

Outlook.com, Hotmail and Microsoft 365 accounts sign in only with Microsoft's own sign-in (OAuth), which Kite does not support yet, so they cannot be connected. Choosing that provider in the dialog offers **Set up forwarding**, which opens the [forwarding guide](#forward-mail-to-kite-instead) at Outlook.

After connecting, **Import existing mail** (in the confirmation, or **Import mail** on the account) opens Settings → Import with the account chosen under **Sign in with** and the account's mailbox selected, so the import goes where its new mail goes: show the folders (with each folder's size and the totals the import adds, see [Importing a whole account](modules.md#importing-a-whole-account)), adjust the mapping and start the import. The import job keeps no password of its own; every run asks for the account's login, so removing the account stops its imports at their next run ("The account was removed").

## New mail

Every 5 minutes (or the interval you chose) Kite signs in, looks at the account's Inbox and fetches what arrived since the last check. Mail is delivered into the account's mailbox exactly like mail Kite receives itself:

- The **spam filter**, your **mailbox rules** and the **Screener** apply: an unknown sender waits in the Screener, spam goes to Spam. For Gmail and Google Workspace accounts Kite believes Google's own verdict on the sender (its `Authentication-Results` header, when Google's own `Received` line is above it); for other providers it has none, as for mail from the SMTP listener, so calendar invitations show the unverified-sender note.
- **Notifications**, **webhooks** (`message.inbound` with `"source": "external"` and the `accountId`) and **automatic reading** work as for received mail. Kite sends no **auto-reply** for synced mail: the provider has its own, and Kite's would come from your Kite address.
- Mail you already read or starred at the provider (on your phone, say) arrives **read** or **starred**, and without a notification.
- A message Kite already has from this account, from an import or from sending it in Kite (the same Message-ID, for example one you imported, or one moved back into the Inbox at the provider) is not stored again. Mail that reached Kite any other way is not compared, so a forged copy sent to your Kite address cannot hide the real message; mail you also forward from the provider to Kite arrives twice.
- New mail belongs to the mailbox it goes to. In a shared mailbox it is the mailbox owner's, like mail the mailbox receives: their spam training, rules and webhooks apply, whoever connected the account. So when you connect your account to a mailbox someone else owns, **their** webhooks are told about your synced mail (sender, recipients, subject and the account's id) and yours are not.
- If Kite may not bring in mail for a while (your permission or connected accounts turned off), messages it had already fetched are fetched again once that changes, so nothing is lost.
- Kite checks only the Inbox (and the Spam folder, [when you turn that on](#the-spam-folder)), and only fetches each message once. Unless you turn on [two-way sync](#two-way-sync), deleting, moving or reading a message at the provider afterwards changes nothing in Kite, and nothing you do in Kite changes the provider. A message deleted at the provider before Kite's next check never arrives. A message larger than 25 MB, or one the provider will not send, is skipped and named in the account's problems; the messages after it still arrive.
- If the provider rebuilds the Inbox (its UIDVALIDITY changes), Kite checks the last two days again and keeps only what it does not have yet; the account notes "The provider reset the Inbox; Kite checked the last two days again."

On each account, **Check now** checks at once (at most once a minute), and **Pause** stops checking until you choose **Resume**. The account says when it was last checked and when the next check is due. For mail the moment it arrives, [forward](#forward-mail-to-kite-instead) instead of connecting (doing both brings every message in twice).

### The Spam folder

**Also sync the Spam folder** on an account (off by default) checks the provider's Spam folder with the Inbox, for when you want to see what the provider filed away by mistake. Kite finds the folder by its special-use mark (`\Junk`, as Gmail's `[Gmail]/Spam` has) or, on servers without one, by its name (Spam, Junk, Junk E-mail, Junk Mail or Bulk Mail, at the top level or directly under the Inbox, such as `INBOX.Junk`). A folder of your own further down, such as `Projects/Spam`, never counts.

- Mail from the provider's Spam folder always lands in Kite's **Spam**, whatever Kite's own filter makes of it. Kite still runs its spam filter on it and keeps the result, with "The provider filed this message in its Spam folder" added, so the message's spam details show both. Your mailbox rules and the Screener do not move it, and it brings no notification and no `message.inbound` webhook, like any spam. Use **Not spam** to rescue a false positive.
- It starts when you turn it on: what was already in the provider's Spam folder stays out, and so does what collected there while the switch was off. The switch needs no password and takes effect at the next check.
- A message moved out of the provider's Spam folder into its Inbox after Kite fetched it is not fetched again (Kite already has it), and stays in Kite's Spam.
- If the provider has no folder Kite can recognise as its Spam folder, only the Inbox is checked. If the provider renames its Spam folder, Kite finds the new one and starts it afresh.
- The Inbox always comes first. A Spam folder the provider will not open, or any other problem with it, never stops new Inbox mail: the check still counts as working and the account's recent problems say "Kite could not check the Spam folder this time; the Inbox was checked". Only a sign-in or certificate that stops working fails the check, as it would for the Inbox. When a check stops early (you may no longer bring in mail, or there is more Inbox mail than one check takes), the Spam folder waits for a later check.

## Two-way sync

Out of the box a connected account is one-way: Kite fetches each new message once. **Two-way sync** on the account (**Settings → Connected accounts**, under the account) lets you choose what else stays in step, per direction. Everything is off until you turn it on, and only the account's owner can change it.

| When you… | Choices |
| --- | --- |
| **Delete in Kite** | Nothing · Move to the provider's Trash |
| **Archive in Kite** | Nothing · Archive at the provider |
| **Move to Spam in Kite** | Nothing · Move to the provider's Spam |
| **Read, unread and star in Kite** | Off · On |

| When at the provider a message is… | Choices |
| --- | --- |
| **Deleted or moved out of the Inbox** | Nothing · Move to Kite's Trash |
| **Read, unread or starred** | Off · On |

- **Nothing is ever deleted permanently.** Deleting in Kite moves the message to the provider's Trash, and the provider empties that itself (Gmail after 30 days). **Delete forever** on a message you pick in Trash does the same, for any message you pick there, including one a rule put there. A message that left at the provider goes to Kite's Trash, where it is kept like anything else you throw away.
- **Spam and Empty Trash.** A delete out of Kite's Spam (Delete, **Delete forever**, **Empty Spam**) reaches the provider only for mail that came from the provider's own Spam folder: what Kite's filter or you filed there is still in the provider's Inbox, and stays. **Empty Trash** sends nothing new: what you deleted yourself went to the provider when you deleted it, and what a rule, the filter or the Screener put in Trash stays where it is at the provider.
- **Which servers.** Kite asks the server what it can do, and a choice it cannot carry out is not offered. Moving needs the server's MOVE command, or UIDPLUS as a fallback (a copy, then removing exactly that message); a server with neither gets no moves at all. Trash and Spam are the folders the server marks as such, or the usual names at the top level. Archive needs a folder marked Archive; on Gmail and Google Workspace it takes the message out of the Inbox and keeps it in All Mail. Read, unread and star work everywhere.
- **Only mail Kite fetched from this account**, found by the message's number at the provider and checked against its Message-ID. If the two do not agree, or the message has no Message-ID, Kite leaves it alone and says so in the problems. Mail you **imported** is not touched: an import does not record where a message came from precisely enough. Sent mail is not touched either, not even the copy of a message you sent yourself with a Cc to your own address.
- **Only what you do, from when you turn it on.** Mailbox rules, the spam filter, the Screener, Kite's automatic Trash cleanup and deleting a Kite folder stay in Kite: mail Kite moved by itself stays where it is at the provider. Anyone with full access to the mailbox acts on its mail like you do, and the settings of the account's owner decide what reaches the provider; someone with read-only access changes only Kite, read and star included. Mail left behind in a mailbox the account no longer delivers to stays out of it.
- **When it happens.** A change in Kite waits a minute before anything may send it, so an **Undo** within that minute always wins, even over a regular check. After that it goes out by itself or at the next check, in batches, with one connection per account. A failed change is tried again up to six times over about nine hours; waiting changes and recent problems show under **Two-way sync**. While the account is paused, or its sign-in does not work, changes wait. Turning a setting off drops what waits for it.
- **From the provider to Kite** happens at each regular check, so within the account's interval. It compares **the newest 5,000 Inbox messages Kite fetched** and makes at most 500 changes per check; the rest follow at the next check. Older messages stay as they are. The Spam folder is not compared, so a provider emptying its own Spam folder changes nothing in Kite.
- **The first check after turning it on only looks.** Whatever changed at the provider before that stays as it is in Kite, so turning this on does not move your old mail to Trash.
- **A message counts as gone only after two checks.** The first check that misses a message only notes it. The next check, a separate connection, asks for that message by its own number, and it goes to Kite's Trash only if the provider still has nothing. So a delete at the provider reaches Kite after two checks, ten minutes at the default interval.
- **Kite does not believe an Inbox that looks wrong.** When the provider shows an empty Inbox, far fewer messages than Kite tracks (under half of ten or more), or an answer that does not add up to what the folder says it holds, nothing moves to Trash until that clears, and the problems say so once. Read and star keep working. If you really did empty the Inbox or clean it out, turn **Deleted or moved out of the Inbox** off and on again: Kite starts over from what is there, and the messages that left stay in Kite. A small Inbox you emptied also clears by itself once new mail arrives. An incomplete answer does not clear this way: that one waits for the provider to answer in full.
- **On Gmail, keep the IMAP folder size limit off.** If you set one in Gmail's settings (**Forwarding and POP/IMAP → Folder size limits**), older mail drops out of what IMAP shows and looks deleted to Kite.
- **Both sides changed?** The last one wins. A provider does not say when a flag changed, only that it did since the last check, so a change you make in Kite after that check wins over one found at the provider, and a change at the provider beats a Kite change that was already waiting before that check.

What it does not do:

- **Gmail's archive looks like a delete.** Over IMAP both simply take the message out of the Inbox, so with **Deleted or moved out of the Inbox** on, archiving in Gmail also moves the message to Kite's Trash.
- **Restoring does not travel.** Restoring a message in Kite, or an Undo after the minute, leaves the provider's copy where it went; moving a message back into the Inbox at the provider does not take it out of Kite's Trash.
- **Kite's folders and snooze stay in Kite**, and so does marking a message as not spam.
- If the provider rebuilds its Inbox (a new UIDVALIDITY), waiting changes are dropped and named in the problems, nothing is moved, and the last two days are matched again.

## Which account mail came through

Mail that came in through a connected account is marked **via** the account: in the message list and in the reader beside the date. The marker names the account's label, or its provider while the label is still the address (`via Gmail`, `via iCloud Mail`, or the domain for **Other IMAP provider**); hover it to see the address. Mail you send as the account in Kite carries it too. Mail that reached your Kite address any other way (forwarded mail included) has none, and once you remove the account its mail keeps its content but loses the marker.

In the message list the marker is a small link icon by default, with the account in its accessible name and tooltip, so the subject keeps its room; **Settings → Inbox → Labels in the message list** chooses **Compact** (the icon, and a coloured square for the mailbox in [All mailboxes](all-mailboxes.md#what-you-see)), **Full** (the `via Gmail` text chip and the mailbox's name) or **Off** (neither in the rows). The setting follows your account with the rest of your [layout](privacy.md). The open message always shows the full chip, and choosing it there opens the account's [view](#connected-account-views). You can also search with `via:` yourself, combined with anything else:

| Search | Finds mail that came through |
| --- | --- |
| `via:gmail`, `via:icloud`, `via:fastmail`, `via:yahoo`, `via:aol` | any account at that provider (`via:google` covers Gmail and Google Workspace, `via:outlook` Microsoft) |
| `via:me@gmail.com` | the account with that address |
| `via:"Work mail"` | the account with that label (case does not matter) |
| `via:example.org` | any account whose address is at that domain |

`via:` needs migration 0079; before it is applied it finds nothing.

### Connected account views

Each account you connected is listed in the sidebar under **Connected accounts**, below **Management** and above **Folders**, as a view of the Inbox with only the mail that came in through it. A short line under the heading says so ("Each shows only the mail that came in through that account. Nothing is moved.") until you open a view or choose **Got it**, and each entry's tooltip says the same with the account's address.

- **A view, not a search and not a mailbox.** Choosing an entry narrows the Inbox with the same server-side `via:<the account's address>` filter the reader's chip uses, but the search box stays empty: the list's title becomes the view's name (the account's label or provider, with the address in its tooltip) and an arrow before it goes **Back to Inbox**. Nothing is moved or stored. Typing in the search box searches within the view. The view lives in the address (`/inbox?via=<address>`), so the browser's Back and Forward, the sidebar's Inbox and a reload all agree with what the list shows; it closes when you leave the mail pages or switch to a mailbox that does not receive the account's mail. On a phone, choosing a view closes the menu. The other mail lists (Sent, Archive, …) narrow the same way while a view is open, titled with the view and the folder; **Empty Trash** and **Empty Spam** are not offered there, since they would empty the whole folder.
- **Only your own accounts, under their mailbox.** With one mailbox selected the section lists the accounts that deliver into it; in All mailboxes every account is listed under the name of the mailbox it delivers into. It is hidden when you have no account there, in the icon-only sidebar, and before migration 0079. Someone you share a mailbox with sees your account's mail marked via it, but not your account in their sidebar.
- **Named like the marker.** An entry reads as the account's label (or its provider). The row you are on is highlighted instead of Inbox, and choosing the chip in an open message opens the same view.
- **No counts.** Unlike folders, the entries show no unread numbers.

### Colours of the marks

The mailbox's square and the account's icon take a colour you choose, so a mailbox is recognisable at a glance and the same colour shows in the sidebar: a small square on the mailbox's avatar and beside its name above its folders and accounts in All mailboxes, and the account's icon in its sidebar row. Choose them in **Settings → Inbox → Label colours**, which lists each mailbox you can open and each account you connected, or, for an account, from the **⋯** button on its sidebar row.

- **Eight colours** (blue, purple, pink, red, orange, amber, green, teal), each readable (at least 3:1) on the list's light and dark backgrounds, Kite classic's included. A mailbox you have not chosen for gets an automatic colour from the same eight, fixed by the mailbox itself, so adding or removing another mailbox never changes it (two mailboxes can share one; choose a colour to tell them apart). An account's icon stays grey until you choose.
- **They follow your account** with the rest of the layout (no database change), in the browser's storage and on the account's layout, keyed by mailbox and account. Colours of mailboxes and accounts that are gone are ignored, and dropped the next time you choose a colour or when Settings → Inbox opens once your account's layout has loaded (so a cleanup never overwrites colours saved on another device).

## Forward mail to Kite instead

Forwarding is set up at the provider, once, and needs nothing stored in Kite: each message is delivered to your Kite address the moment it arrives, like any other mail to it. **Settings → Connected accounts** has the steps for Gmail, Outlook.com and Microsoft 365, iCloud Mail, Yahoo Mail, Fastmail and other providers, with your Kite address filled in (choose another of your mailboxes under **Forward to**) and links to the provider's own forwarding settings:

| Provider | Where | Notes |
| --- | --- | --- |
| Gmail and Google Workspace | [Settings → Forwarding and POP/IMAP](https://mail.google.com/mail/u/0/#settings/fwdandpop) → **Add a forwarding address** | Gmail mails a confirmation code to the Kite address; it arrives in Kite. Then choose **Forward a copy of incoming mail to** and keep Gmail's copy. Gmail does not forward what it filed as spam; a Workspace admin can turn forwarding off. ([help](https://support.google.com/mail/answer/10957)) |
| Outlook.com | [Settings → Mail → Forwarding](https://outlook.live.com/mail/0/options/mail/forwarding) → **Enable forwarding**, **Keep a copy of forwarded messages** | May ask you to turn on two-step verification first. ([help](https://support.microsoft.com/office/6246987c-6c8f-4144-b255-14fc07007dad)) |
| Microsoft 365 | [Settings → Mail → Forwarding](https://outlook.office.com/mail/options/mail/forwarding) | Many organisations block forwarding to outside addresses; forwarded mail then bounces with "Your organization does not allow external forwarding". Ask your admin to allow it for your mailbox. |
| iCloud Mail | [iCloud Mail](https://www.icloud.com/mail) → settings button → **Settings → Mail Forwarding** → **Forward my email to** | Leave **Delete messages after forwarding** off. ([help](https://support.apple.com/guide/icloud/mm6b1a3960/icloud)) |
| Yahoo Mail | [Yahoo Mail](https://mail.yahoo.com/) → **Settings → More Settings → Mailboxes** → your address → **Forwarding** → **Verify** | Only with Yahoo Mail Plus; on a free account, connect the account instead. Choose **Store and forward**. ([help](https://help.yahoo.com/kb/SLN29133.html)) |
| Fastmail | [Settings → Mail rules](https://app.fastmail.com/settings/rules) → **Create rule** → **All messages** → **Send a copy to** | ([help](https://www.fastmail.help/hc/en-us/articles/360058753434)) |
| Other providers | the webmail's settings: **Forwarding**, **Auto-forward** or **Mail rules** | Forward all incoming mail and keep a copy at the provider. |

Then check that it works:

- Send a test message **from another address** to the account (mail you send to yourself is often not forwarded). It should be in Kite within a minute.
- Nothing arrived? Look in **Spam** and the **Screener**. Forwarded mail fails the original sender's SPF check, so Kite's spam filter relies on DKIM and ARC; most mail from large senders still passes.
- Optionally, add a mailbox rule (**Settings → Rules**) that files mail whose **To** is the account's address into a folder.
- Do not also connect the same account for its new mail: Kite does not compare forwarded mail with synced mail, so every message would arrive twice. Connecting just to import old mail or to send as the address is fine; pause its checking.

## What the list shows

Each account shows its label, address, provider, the mailbox its mail goes to, its state and where checking for new mail stands:

| State | Meaning | What to do |
| --- | --- | --- |
| Connected | Kite can sign in and checks for new mail ("Checked 2 minutes ago · next check at 14:35"). | Nothing. |
| Connected, with "The provider is limiting connections; Kite will try again at 14:35." | The provider asked Kite to slow down. Kite waits, from 15 minutes up to 6 hours. | Nothing. |
| Connected, with "Could not reach imap.example.com since 09:10; retrying." | The server has not answered three checks in a row (shown from the third). Kite keeps trying, waiting longer each time. | Nothing, unless it lasts. |
| Sign-in failed | The provider refused the password (it was changed or revoked), or the saved password can no longer be opened because `APP_ENCRYPTION_KEY` changed. Checking stops, a notice in the sidebar says so, and your open Kite tabs show a message once. | **Reconnect** with the current (app) password. |
| Certificate problem | The server's TLS certificate is not valid for its name. Checking stops. | Edit the server, or ask the provider. |
| Error | Kite refused the server (a private address, another port), the server lacks something Kite needs (an Inbox, a password sign-in), you no longer have full access to the account's mailbox, or the server has not answered for a day (then Kite keeps trying every 6 hours). The sidebar notice lists it. | Edit the account, or **Check now** once the problem is fixed. |
| Paused | Your admin took away your permission to connect accounts (connected accounts that were working show this). | Ask your admin. |
| Password erased | Kite was not allowed to use the account for 30 days (your permission was gone, or connected accounts were off for this Kite), so its saved password was erased. | **Reconnect** with the password. |

**Test connection** signs in with the saved password, at the saved servers (IMAP, and SMTP when the account has one), and records the result; a working test makes a failed account **Connected** again. **Edit** changes the label, the mailbox or how often Kite checks at once; moving **Mail goes to** to another mailbox applies to mail that arrives from then on, mail already delivered stays where it is, and an import chooses its own destination (the account's mailbox by default). Changing the password, the user name, the provider or any server (IMAP or SMTP) needs the account's password again, your Kite password and a new successful test: Kite never sends a saved password to a server other than the one it was saved for. **Remove** forgets the account and its password and stops checking it at once; mail already imported or synced stays in Kite, and nothing changes at the provider. While you may not use connected accounts (above), **Remove** is the only thing that works.

## Send as the account's address

Once the SMTP sign-in has worked, the account's address is in the composer's **From** menu, after the addresses of the mailbox its mail goes to, as `you@gmail.com (via Gmail)`. Mail you send from it goes out through the provider's own SMTP server (`smtp.gmail.com`, `smtp.mail.me.com`, …), not through Kite's own sending, so it carries the provider's SPF and DKIM and reaches inboxes like mail from the provider's own app. Kite's Cloudflare, Resend or SES sending cannot send as an address outside your Kite domains: they refuse it, and recipients would see it fail DMARC.

- **Replies come from the address the mail came to.** When a message in Kite was addressed to the connected address (forwarded or synced mail), **Reply** and **Reply all** start from that address. You can always pick another one in **From**.
- **Only your own accounts.** Only the person who connected an account can send as it, and only in the mailbox its mail goes to. Sharing that mailbox never shares the account: others see their own addresses only. Sending as a connected account works only in Kite's composer, never through API keys, MCP, JMAP or automations; a draft with a connected From sent any other way is refused with "Sending as a connected account works only from Kite's composer".
- **A proven address.** Kite offers the address a Gmail, Google Workspace, iCloud Mail, Yahoo, AOL or Fastmail account signs in with: signing in at the provider's own server proves you own that address. Any other address needs a verification code first (below): an **Other IMAP provider** account's address, even when its SMTP sign-in works (you chose its server, and a server can accept any address), the address of an account whose user name is not its address, and provider aliases. Until then such an address shows **(Verify in Settings)** in the From menu and cannot be chosen.
- **Everything else stays the same.** Sends count towards your sending allowance, **Undo send** and scheduled sends work as usual, and the message lands in Kite's **Sent** with the exact bytes that went out (**Show original**). A scheduled or undoable send checks the account again when it goes out: if the account was removed or now delivers into another mailbox, sending was turned off, you can no longer send from the mailbox, your Kite account was disabled or connected accounts are no longer allowed, the message fails in Sent with the reason. A send waiting on a slow provider is never shown as stalled, so it cannot be taken back and sent twice.
- **A copy in the provider's Sent folder.** Gmail and Google Workspace keep every message sent through their server in Sent themselves. For the other providers Kite saves a copy in the account's Sent folder after each send (marked read), so your phone and the provider's webmail show it too. It is tried three times; if it still fails, the send itself is not affected and the account's recent problems say so. Turn it off with **Save a copy in the provider's Sent folder** on the account; for Gmail and Google Workspace the account says the provider keeps its own copy instead of showing the switch.
- **Size.** Each provider limits one message, attachments included and counted after encoding: Gmail, Google Workspace, Yahoo and AOL 25 MB, iCloud Mail 20 MB, Fastmail 70 MB. A larger message is refused before it is sent, naming the limit. Kite does not turn large attachments into download links for these sends.
- **When the provider refuses.** A temporary refusal (`4xx`) is tried again after a minute, then after five; the message waits in **Sent** as queued meanwhile and can still be taken back. A permanent refusal (`5xx`) fails the message in Sent with the server's reply. A refused password (`535`) also sets the account to **Sign-in failed**, and the address shows **(Reconnect in Settings)** in the From menu until you reconnect.
- **Delivery unknown.** When the connection breaks after the message went out and before the provider answered, the provider may have accepted it. Kite never sends it again on its own; the message fails in Sent with "Delivery unknown: check the recipient or the provider's Sent folder before sending again".

### Verify an address with a code

To send as an address the sign-in does not prove, open **Settings → Connected accounts** and, on the account's row:

1. Click **Verify** *address* for the account's own address, or **Send from another address** for an alias you have at the provider (for example a second Gmail address set up under Gmail's own "Send mail as", or a Fastmail alias), and enter it.
2. Click **Send code**. Kite mails a 6-digit code to that address, from your Kite's own sending address. Mail to the address must reach you somewhere (at the provider, or in Kite through the connected account).
3. Enter the code and click **Verify**. The address is now in the composer's **From** menu as `address (via provider)`, and mail from it goes out through the account's SMTP server, like the account's own address.

- **What the code proves.** That you receive mail at the address. It does not prove the account's SMTP server accepts it as a sender: some providers refuse or rewrite a From that is not set up there, so add an alias at the provider first.
- **Limits.** A code works for 30 minutes and for 5 tries; after that, or after **Send a new code**, it no longer works. Kite stores only a keyed hash of it. Each user can ask for 5 codes an hour, at most 3 of them for the same address, and an address gets at most 10 codes a day whoever asks, so the form cannot be used to send mail to anyone. After 10 wrong codes in a day an address gets no new code or try until the next day. An account can have up to 10 other addresses; addresses on this Kite's own domains are refused, as for connecting.
- **Sending mail.** The code is sent like a password-reset email: from the first administrator's mailbox on a domain that can send. If no domain can send, Kite says it could not send the code.
- **Remove** next to an alias stops sending as it at once; scheduled and undoable sends from it fail in Sent. Removing the account removes its addresses too. Verified addresses stay verified when you edit or reconnect the account.

Each account row says whether you can send as its address and, if not, what to do. **Send from this address** turns sending off for that account (the address leaves the From menu); **Save a copy in the provider's Sent folder** is described above.

## Security

- **Encrypted only.** Kite connects over TLS (ports 993 and 465) or STARTTLS (ports 143 and 587), checks the server's certificate and never sends a password over a plain connection. It refuses private and local addresses and ports other than 993, 143, 465 and 587. On the Node runtime it resolves the server's name itself and refuses it when any address is private (`EXTERNAL_ACCOUNTS_ALLOW_PRIVATE_HOSTS=1` allows a mail server on your LAN; see [Self-hosting](self-hosting.md)).
- **Sealed passwords.** The password is stored encrypted with `APP_ENCRYPTION_KEY` and never shown again, logged, sent in a webhook or written to an audit entry. Without the key, accounts cannot be connected at all.
- **Rate limit.** Each user gets 10 connection attempts (connect, test or reconnect) in 10 minutes. Every attempt counts, refused ones too, and the limit is checked before your Kite password or anything else, so the form cannot be used to guess passwords, probe addresses or scan servers. Provider detection has its own small per-user limit. The import page has a separate limit on failed sign-ins to the servers you type there ([Mail import](modules.md#failed-sign-ins-and-oversized-messages)); importing from a connected account counts toward it only when the saved login fails.
- **Backups** keep each account's settings but never its password. After a restore, every account shows **Sign-in failed** with "Reconnect after restore" until you reconnect it. Verified addresses stay verified; a code that was still waiting is not kept.
- **Audit.** Connecting, editing, removing, every connection test and admin changes are recorded in the audit log (`external_account.*`), with the account's address and server but never the password or user name. Checking for new mail records when it stops working and when it works again (`external_account.sync_failed`, `external_account.sync_recovered`), with the kind of problem only. Verification codes record each request, wrong code, verification and removal (`external_identity.code_attempted`, `external_identity.code_requested`, `external_identity.verify_failed`, `external_identity.verified`, `external_identity.revoked`) with the address, never the code.

## For admins

- **Admin → General → Connected accounts → Allow connected accounts** turns the feature on or off for everyone. It is on by default when `APP_ENCRYPTION_KEY` is set, and off (and cannot be turned on) without it. Turning it off stops every account from being used: nothing signs in with them, no new mail is fetched or delivered, and they cannot be connected, edited, tested or imported from, only removed. They keep the state they had, under a notice that connected accounts are off. Their passwords stay for 30 days; then the daily 02:00 UTC run erases them and the accounts show **Password erased**. Turning it back on within the 30 days stops that.
- **Admin → Accounts → (account) → Permissions → Connected accounts** allows or forbids one user to connect accounts, and shows how many connected accounts the user has in which states (never which accounts, their passwords or mail). Taking the permission away stops that user's accounts the same way (working ones show **Paused**) and starts the same 30-day clock for every account that still holds a password, whatever its state; giving it back within the 30 days resumes them.
- A disabled Kite account's connected accounts are not checked either, and new mail is only delivered while the owner has full access to the chosen mailbox.
- Connected accounts need database migration 0079, and migration 0082 for **Other IMAP provider** addresses to stop reserving the address. Until 0079 is applied from the admin overview, the page says "Apply the pending database update to use connected accounts" and nothing is checked.
- Sending as a connected account also needs migration 0083; until it is applied, no connected address is offered in the From menu.
- Verification codes need migration 0089 (`external_identities`); until it is applied, asking for a code answers "Apply the pending database update to use connected accounts", and only known providers' sign-in addresses can be sent as.
- Turning connected accounts off, or taking a user's permission away, also stops sending as those accounts at once, scheduled sends included.
