# Connected accounts

A connected account is a mail account at another provider (Gmail, Google Workspace, iCloud Mail, Yahoo Mail, AOL Mail, Fastmail or any other IMAP provider) whose sign-in Kite keeps, so you can bring its mail into Kite without typing the password each time. Kite only reads from the account; it never deletes, moves or marks anything there.

A connected account does three things:

- **New mail arrives in Kite.** Kite checks the account's Inbox every few minutes and delivers what arrived since you connected it into the account's mailbox (see [New mail](#new-mail)).
- **Existing mail can be imported.** **Import mail** copies the account's existing mail into Kite in the background (see [Importing a whole account](modules.md#importing-a-whole-account)).
- **You can [send as its address](#send-as-the-accounts-address)** from the composer, through the provider's own mail server. That is the only thing Kite ever writes at the provider: the provider keeps the sent message, and Kite may save a copy in its Sent folder.

## Connect an account

1. Open **Settings → Connected accounts** (`/settings/connected-accounts`) and choose **Connect account**.
2. Enter the account's email address. Kite recognises the provider from the address (`gmail.com`, `icloud.com`, `yahoo.co.uk`, …) or, for your own domain, from where its MX records point (Google Workspace, Microsoft 365, iCloud+ custom domains, Fastmail). Check the **Provider**, or choose **Other IMAP provider** and enter the IMAP server, port and encryption yourself, and the SMTP server if you want to send from the address (optional). With a known provider Kite signs in at that provider's own server with the address itself, so the sign-in proves the address. **Other IMAP provider** accepts a different user name, and because you name its server yourself, its sign-in proves nothing about the address (see step 6).
3. Enter the password. Most providers need an **app password** for mail apps once two-step sign-in is on; the dialog says where to make one:
   - Gmail: Google Account → Security → 2-Step Verification → App passwords. Google Workspace: the same, if your Workspace admin allows app passwords.
   - iCloud Mail: Apple Account → Sign-In and Security → App-Specific Passwords.
   - Yahoo and AOL: Account Security → Generate app password.
   - Fastmail: Settings → Privacy & Security → Manage app passwords.
4. Choose **Mail goes to**: the Kite mailbox the account's mail arrives in and is imported into. You need full access to it. If others can read that mailbox, the dialog says so: everyone with access to it will see the account's mail. Choose how often Kite should **Check for new mail**: every 5 minutes (the default), every 15 minutes or every hour.
5. Enter **your Kite password** again. Kite asks for it because it is about to store another account's password.
6. **Connect.** Kite signs in to the account and opens its Inbox read-only. Only when that works is the account saved, and Kite notes where the Inbox stands: checking for new mail starts with mail that arrives after this moment. An address at a known provider can be connected once in this Kite. That is checked only after the provider's own server accepted the password, so nobody learns whether such an address is connected without its password, and the answer never says by whom. An **Other IMAP provider** account is never checked against other accounts and does not reserve its address, because anyone can run a server that accepts any address: someone else may connect the same address, and the answer never tells whether it is connected already. Kite then also signs in to the provider's SMTP server with the same password, without sending anything; when that works, you can send as the address. When it does not, the account is still connected and its row says why sending is not available (**Test connection** tries again).

Outlook.com, Hotmail and Microsoft 365 accounts sign in only with Microsoft's own sign-in (OAuth), which Kite does not support yet, so they cannot be connected; forward their mail to your Kite address instead.

After connecting, **Import existing mail** (in the confirmation, or **Import mail** on the account) opens Settings → Import with the account chosen under **Sign in with**: show the folders, adjust the mapping and start the import. The import job keeps no password of its own; every run asks for the account's login, so removing the account stops its imports at their next run ("The account was removed").

## New mail

Every 5 minutes (or the interval you chose) Kite signs in, looks at the account's Inbox and fetches what arrived since the last check. Mail is delivered into the account's mailbox exactly like mail Kite receives itself:

- The **spam filter**, your **mailbox rules** and the **Screener** apply: an unknown sender waits in the Screener, spam goes to Spam. For Gmail and Google Workspace accounts Kite believes Google's own verdict on the sender (its `Authentication-Results` header, when Google's own `Received` line is above it); for other providers it has none, as for mail from the SMTP listener, so calendar invitations show the unverified-sender note.
- **Notifications**, **webhooks** (`message.inbound` with `"source": "external"` and the `accountId`) and **automatic reading** work as for received mail. Kite sends no **auto-reply** for synced mail: the provider has its own, and Kite's would come from your Kite address.
- Mail you already read or starred at the provider (on your phone, say) arrives **read** or **starred**, and without a notification.
- A message Kite already has from this account, from an import or from sending it in Kite (the same Message-ID, for example one you imported, or one moved back into the Inbox at the provider) is not stored again. Mail that reached Kite any other way is not compared, so a forged copy sent to your Kite address cannot hide the real message; mail you also forward from the provider to Kite arrives twice.
- New mail belongs to the mailbox it goes to. In a shared mailbox it is the mailbox owner's, like mail the mailbox receives: their spam training, rules and webhooks apply, whoever connected the account.
- If Kite may not bring in mail for a while (your permission or connected accounts turned off), messages it had already fetched are fetched again once that changes, so nothing is lost.
- Kite checks only the Inbox, and only fetches each message once. Deleting, moving or reading a message at the provider afterwards changes nothing in Kite, and nothing you do in Kite changes the provider. A message deleted at the provider before Kite's next check never arrives. A message larger than 25 MB, or one the provider will not send, is skipped and named in the account's problems; the messages after it still arrive.
- If the provider rebuilds the Inbox (its UIDVALIDITY changes), Kite checks the last two days again and keeps only what it does not have yet; the account notes "The provider reset the Inbox; Kite checked the last two days again."

On each account, **Check now** checks at once (at most once a minute), and **Pause** stops checking until you choose **Resume**. The account says when it was last checked and when the next check is due. For mail the moment it arrives, also set up forwarding at the provider to your Kite address.

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

**Test connection** signs in with the saved password, at the saved servers (IMAP, and SMTP when the account has one), and records the result; a working test makes a failed account **Connected** again. **Edit** changes the label, the mailbox or how often Kite checks at once. Changing the password, the user name, the provider or any server (IMAP or SMTP) needs the account's password again, your Kite password and a new successful test: Kite never sends a saved password to a server other than the one it was saved for. **Remove** forgets the account and its password and stops checking it at once; mail already imported or synced stays in Kite, and nothing changes at the provider. While you may not use connected accounts (above), **Remove** is the only thing that works.

## Send as the account's address

Once the SMTP sign-in has worked, the account's address is in the composer's **From** menu, after the addresses of the mailbox its mail goes to, as `you@gmail.com (via Gmail)`. Mail you send from it goes out through the provider's own SMTP server (`smtp.gmail.com`, `smtp.mail.me.com`, …), not through Kite's own sending, so it carries the provider's SPF and DKIM and reaches inboxes like mail from the provider's own app. Kite's Cloudflare, Resend or SES sending cannot send as an address outside your Kite domains: they refuse it, and recipients would see it fail DMARC.

- **Replies come from the address the mail came to.** When a message in Kite was addressed to the connected address (forwarded or synced mail), **Reply** and **Reply all** start from that address. You can always pick another one in **From**.
- **Only your own accounts.** Only the person who connected an account can send as it, and only in the mailbox its mail goes to. Sharing that mailbox never shares the account: others see their own addresses only. Sending as a connected account works only in Kite's composer, never through API keys, MCP, JMAP or automations; a draft with a connected From sent any other way is refused with "Sending as a connected account works only from Kite's composer".
- **Only a known provider's sign-in address.** Kite offers the address a Gmail, Google Workspace, iCloud Mail, Yahoo, AOL or Fastmail account signs in with: signing in at the provider's own server proves you own that address. An **Other IMAP provider** account is not offered, even when its SMTP sign-in works, because you chose its server and a server can accept any address; sending from it, from an account whose user name is not its address, or from a provider alias needs proving the address with a code sent to it, which comes in a later version. Its row says so.
- **Everything else stays the same.** Sends count towards your sending allowance, **Undo send** and scheduled sends work as usual, and the message lands in Kite's **Sent** with the exact bytes that went out (**Show original**). A scheduled or undoable send checks the account again when it goes out: if the account was removed or now delivers into another mailbox, sending was turned off, you can no longer send from the mailbox, your Kite account was disabled or connected accounts are no longer allowed, the message fails in Sent with the reason. A send waiting on a slow provider is never shown as stalled, so it cannot be taken back and sent twice.
- **A copy in the provider's Sent folder.** Gmail and Google Workspace keep every message sent through their server in Sent themselves. For the other providers Kite saves a copy in the account's Sent folder after each send (marked read), so your phone and the provider's webmail show it too. It is tried three times; if it still fails, the send itself is not affected and the account's recent problems say so. Turn it off with **Save a copy in the provider's Sent folder** on the account; for Gmail and Google Workspace the account says the provider keeps its own copy instead of showing the switch.
- **Size.** Each provider limits one message, attachments included and counted after encoding: Gmail, Google Workspace, Yahoo and AOL 25 MB, iCloud Mail 20 MB, Fastmail 70 MB. A larger message is refused before it is sent, naming the limit. Kite does not turn large attachments into download links for these sends.
- **When the provider refuses.** A temporary refusal (`4xx`) is tried again after a minute, then after five; the message waits in **Sent** as queued meanwhile and can still be taken back. A permanent refusal (`5xx`) fails the message in Sent with the server's reply. A refused password (`535`) also sets the account to **Sign-in failed**, and the address shows **(Reconnect in Settings)** in the From menu until you reconnect.
- **Delivery unknown.** When the connection breaks after the message went out and before the provider answered, the provider may have accepted it. Kite never sends it again on its own; the message fails in Sent with "Delivery unknown: check the recipient or the provider's Sent folder before sending again".

Each account row says whether you can send as its address and, if not, what to do. **Send from this address** turns sending off for that account (the address leaves the From menu); **Save a copy in the provider's Sent folder** is described above.

## Security

- **Encrypted only.** Kite connects over TLS (ports 993 and 465) or STARTTLS (ports 143 and 587), checks the server's certificate and never sends a password over a plain connection. It refuses private and local addresses and ports other than 993, 143, 465 and 587. On the Node runtime it resolves the server's name itself and refuses it when any address is private (`EXTERNAL_ACCOUNTS_ALLOW_PRIVATE_HOSTS=1` allows a mail server on your LAN; see [Self-hosting](self-hosting.md)).
- **Sealed passwords.** The password is stored encrypted with `APP_ENCRYPTION_KEY` and never shown again, logged, sent in a webhook or written to an audit entry. Without the key, accounts cannot be connected at all.
- **Rate limit.** Each user gets 10 connection attempts (connect, test or reconnect) in 10 minutes. Every attempt counts, refused ones too, and the limit is checked before your Kite password or anything else, so the form cannot be used to guess passwords, probe addresses or scan servers. Provider detection has its own small per-user limit.
- **Backups** keep each account's settings but never its password. After a restore, every account shows **Sign-in failed** with "Reconnect after restore" until you reconnect it.
- **Audit.** Connecting, editing, removing, every connection test and admin changes are recorded in the audit log (`external_account.*`), with the account's address and server but never the password or user name. Checking for new mail records when it stops working and when it works again (`external_account.sync_failed`, `external_account.sync_recovered`), with the kind of problem only.

## For admins

- **Admin → General → Connected accounts → Allow connected accounts** turns the feature on or off for everyone. It is on by default when `APP_ENCRYPTION_KEY` is set, and off (and cannot be turned on) without it. Turning it off stops every account from being used: nothing signs in with them, no new mail is fetched or delivered, and they cannot be connected, edited, tested or imported from, only removed. They keep the state they had, under a notice that connected accounts are off. Their passwords stay for 30 days; then the daily 02:00 UTC run erases them and the accounts show **Password erased**. Turning it back on within the 30 days stops that.
- **Admin → Accounts → (account) → Permissions → Connected accounts** allows or forbids one user to connect accounts, and shows how many connected accounts the user has in which states (never which accounts, their passwords or mail). Taking the permission away stops that user's accounts the same way (working ones show **Paused**) and starts the same 30-day clock for every account that still holds a password, whatever its state; giving it back within the 30 days resumes them.
- A disabled Kite account's connected accounts are not checked either, and new mail is only delivered while the owner has full access to the chosen mailbox.
- Connected accounts need database migration 0079, and migration 0082 for **Other IMAP provider** addresses to stop reserving the address. Until 0079 is applied from the admin overview, the page says "Apply the pending database update to use connected accounts" and nothing is checked.
- Sending as a connected account also needs migration 0083; until it is applied, no connected address is offered in the From menu.
- Turning connected accounts off, or taking a user's permission away, also stops sending as those accounts at once, scheduled sends included.
