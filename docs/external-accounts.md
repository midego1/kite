# Connected accounts

A connected account is a mail account at another provider (Gmail, Google Workspace, iCloud Mail, Yahoo Mail, AOL Mail, Fastmail or any other IMAP provider) whose sign-in Kite keeps, so you can bring its mail into Kite without typing the password each time. Kite only reads from the account; it never deletes, moves or marks anything there.

A connected account does two things today. **Import mail** copies the account's existing mail into Kite in the background (see [Importing a whole account](modules.md#importing-a-whole-account)), and you can [send as its address](#send-as-the-accounts-address) from the composer, through the provider's own mail server. Checking the account for new mail is planned next (the design is [External mail accounts](specs/external-accounts.md)). Sending as the account's address is the only thing Kite ever writes at the provider: the provider keeps the sent message, and Kite may save a copy in its Sent folder.

## Connect an account

1. Open **Settings → Connected accounts** (`/settings/connected-accounts`) and choose **Connect account**.
2. Enter the account's email address. Kite recognises the provider from the address (`gmail.com`, `icloud.com`, `yahoo.co.uk`, …) or, for your own domain, from where its MX records point (Google Workspace, Microsoft 365, iCloud+ custom domains, Fastmail). Check the **Provider**, or choose **Other IMAP provider** and enter the IMAP server, port and encryption yourself, and the SMTP server if you want to send from the address (optional). With a known provider Kite signs in with the address itself, so the sign-in proves the address; only **Other IMAP provider** accepts a different user name.
3. Enter the password. Most providers need an **app password** for mail apps once two-step sign-in is on; the dialog says where to make one:
   - Gmail: Google Account → Security → 2-Step Verification → App passwords. Google Workspace: the same, if your Workspace admin allows app passwords.
   - iCloud Mail: Apple Account → Sign-In and Security → App-Specific Passwords.
   - Yahoo and AOL: Account Security → Generate app password.
   - Fastmail: Settings → Privacy & Security → Manage app passwords.
4. Choose **Mail goes to**: the Kite mailbox the account's mail is imported into. You need full access to it. If others can read that mailbox, the dialog says so: everyone with access to it will see the account's mail.
5. Enter **your Kite password** again. Kite asks for it because it is about to store another account's password.
6. **Connect.** Kite signs in to the account and opens its Inbox read-only. Only when that works is the account saved. Whether an address is already connected in this Kite is checked only after that sign-in, so nobody learns it without the account's password. Kite then also signs in to the provider's SMTP server with the same password, without sending anything; when that works, you can send as the address. When it does not, the account is still connected and its row says why sending is not available (**Test connection** tries again).

Outlook.com, Hotmail and Microsoft 365 accounts sign in only with Microsoft's own sign-in (OAuth), which Kite does not support yet, so they cannot be connected; forward their mail to your Kite address instead.

After connecting, **Import existing mail** (in the confirmation, or **Import mail** on the account) opens Settings → Import with the account chosen under **Sign in with**: show the folders, adjust the mapping and start the import. The import job keeps no password of its own; every run asks for the account's login, so removing the account stops its imports at their next run ("The account was removed").

## What the list shows

Each account shows its label, address, provider, the mailbox its mail goes to and its state:

| State | Meaning | What to do |
| --- | --- | --- |
| Connected | Kite can sign in. | Nothing. |
| Sign-in failed | The provider refused the password (it was changed or revoked), or the saved password can no longer be opened because `APP_ENCRYPTION_KEY` changed. | **Reconnect** with the current (app) password. |
| Certificate problem | The server's TLS certificate is not valid for its name. | Edit the server, or ask the provider. |
| Error | Kite refused the server (a private address, another port) or the server lacks something Kite needs. | Edit the account. |
| Paused | Your admin took away your permission to connect accounts (connected accounts that were working show this). | Ask your admin. |
| Password erased | Kite was not allowed to use the account for 30 days (your permission was gone, or connected accounts were off for this Kite), so its saved password was erased. | **Reconnect** with the password. |

**Test connection** signs in with the saved password, at the saved servers (IMAP, and SMTP when the account has one), and records the result. **Edit** changes the label or the mailbox at once. Changing the password, the user name, the provider or any server (IMAP or SMTP) needs the account's password again, your Kite password and a new successful test: Kite never sends a saved password to a server other than the one it was saved for. **Remove** forgets the account and its password at once; mail already imported stays in Kite, and nothing changes at the provider. While you may not use connected accounts (above), **Remove** is the only thing that works.

## Send as the account's address

Once the SMTP sign-in has worked, the account's address is in the composer's **From** menu, after the addresses of the mailbox its mail goes to, as `you@gmail.com (via Gmail)`. Mail you send from it goes out through the provider's own SMTP server (`smtp.gmail.com`, `smtp.mail.me.com`, …), not through Kite's own sending, so it carries the provider's SPF and DKIM and reaches inboxes like mail from the provider's own app. Kite's Cloudflare, Resend or SES sending cannot send as an address outside your Kite domains: they refuse it, and recipients would see it fail DMARC.

- **Replies come from the address the mail came to.** When a message in Kite was addressed to the connected address (forwarded mail today, synced mail later), **Reply** and **Reply all** start from that address. You can always pick another one in **From**.
- **Only your own accounts.** Only the person who connected an account can send as it, and only in the mailbox its mail goes to. Sharing that mailbox never shares the account: others see their own addresses only. Sending as a connected account works only in Kite's composer, never through API keys, MCP, JMAP or automations; a draft with a connected From sent any other way is refused with "Sending as a connected account works only from Kite's composer".
- **Only the address you sign in with.** Kite offers the address the account signs in with (with a known provider that is always the case). An account whose user name is not its address (some **Other IMAP provider** accounts), or a provider alias, is not offered yet: proving another address with a code sent to it comes in a later version.
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
- **Audit.** Connecting, editing, removing, every connection test and admin changes are recorded in the audit log (`external_account.*`), with the account's address and server but never the password or user name.

## For admins

- **Admin → General → Connected accounts → Allow connected accounts** turns the feature on or off for everyone. It is on by default when `APP_ENCRYPTION_KEY` is set, and off (and cannot be turned on) without it. Turning it off stops every account from being used: nothing signs in with them, and they cannot be connected, edited, tested or imported from, only removed. They keep the state they had, under a notice that connected accounts are off. Their passwords stay for 30 days; then the daily 02:00 UTC run erases them and the accounts show **Password erased**. Turning it back on within the 30 days stops that.
- **Admin → Accounts → (account) → Permissions → Connected accounts** allows or forbids one user to connect accounts, and shows how many connected accounts the user has in which states (never which accounts, their passwords or mail). Taking the permission away stops that user's accounts the same way (working ones show **Paused**) and starts the same 30-day clock for every account that still holds a password, whatever its state; giving it back within the 30 days resumes them.
- Connected accounts need database migration 0079. Until it is applied from the admin overview, the page says "Apply the pending database update to use connected accounts". Sending as a connected account also needs migration 0083; until it is applied, no connected address is offered in the From menu.
- Turning connected accounts off, or taking a user's permission away, also stops sending as those accounts at once, scheduled sends included.
