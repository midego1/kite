# Connected accounts

A connected account is a mail account at another provider (Gmail, Google Workspace, iCloud Mail, Yahoo Mail, AOL Mail, Fastmail or any other IMAP provider) whose sign-in Kite keeps, so you can bring its mail into Kite without typing the password each time. Kite only reads from the account; it never deletes, moves or marks anything there.

A connected account does two things:

- **New mail arrives in Kite.** Kite checks the account's Inbox every few minutes and delivers what arrived since you connected it into the account's mailbox (see [New mail](#new-mail)).
- **Existing mail can be imported.** **Import mail** copies the account's existing mail into Kite in the background (see [Importing a whole account](modules.md#importing-a-whole-account)).

Sending as the account's address is planned next (the design is [External mail accounts](specs/external-accounts.md)).

## Connect an account

1. Open **Settings → Connected accounts** (`/settings/connected-accounts`) and choose **Connect account**.
2. Enter the account's email address. Kite recognises the provider from the address (`gmail.com`, `icloud.com`, `yahoo.co.uk`, …) or, for your own domain, from where its MX records point (Google Workspace, Microsoft 365, iCloud+ custom domains, Fastmail). Check the **Provider**, or choose **Other IMAP provider** and enter the IMAP server, port and encryption yourself (the SMTP server is optional and only stored for later). With a known provider Kite signs in at that provider's own server with the address itself, so the sign-in proves the address. **Other IMAP provider** accepts a different user name, and because you name its server yourself, its sign-in proves nothing about the address (see step 6).
3. Enter the password. Most providers need an **app password** for mail apps once two-step sign-in is on; the dialog says where to make one:
   - Gmail: Google Account → Security → 2-Step Verification → App passwords. Google Workspace: the same, if your Workspace admin allows app passwords.
   - iCloud Mail: Apple Account → Sign-In and Security → App-Specific Passwords.
   - Yahoo and AOL: Account Security → Generate app password.
   - Fastmail: Settings → Privacy & Security → Manage app passwords.
4. Choose **Mail goes to**: the Kite mailbox the account's mail arrives in and is imported into. You need full access to it. If others can read that mailbox, the dialog says so: everyone with access to it will see the account's mail. Choose how often Kite should **Check for new mail**: every 5 minutes (the default), every 15 minutes or every hour.
5. Enter **your Kite password** again. Kite asks for it because it is about to store another account's password.
6. **Connect.** Kite signs in to the account and opens its Inbox read-only. Only when that works is the account saved, and Kite notes where the Inbox stands: checking for new mail starts with mail that arrives after this moment. An address at a known provider can be connected once in this Kite. That is checked only after the provider's own server accepted the password, so nobody learns whether such an address is connected without its password, and the answer never says by whom. An **Other IMAP provider** account is never checked against other accounts and does not reserve its address, because anyone can run a server that accepts any address: someone else may connect the same address, and the answer never tells whether it is connected already.

Outlook.com, Hotmail and Microsoft 365 accounts sign in only with Microsoft's own sign-in (OAuth), which Kite does not support yet, so they cannot be connected; forward their mail to your Kite address instead.

After connecting, **Import existing mail** (in the confirmation, or **Import mail** on the account) opens Settings → Import with the account chosen under **Sign in with**: show the folders, adjust the mapping and start the import. The import job keeps no password of its own; every run asks for the account's login, so removing the account stops its imports at their next run ("The account was removed").

## New mail

Every 5 minutes (or the interval you chose) Kite signs in, looks at the account's Inbox and fetches what arrived since the last check. Mail is delivered into the account's mailbox exactly like mail Kite receives itself:

- The **spam filter**, your **mailbox rules** and the **Screener** apply: an unknown sender waits in the Screener, spam goes to Spam. For Gmail and Google Workspace accounts Kite believes Google's own verdict on the sender (its `Authentication-Results` header); for other providers it has none, as for mail from the SMTP listener, so calendar invitations show the unverified-sender note.
- **Notifications**, **webhooks** (`message.inbound` with `"source": "external"` and the `accountId`) and **automatic reading** work as for received mail. Kite sends no **auto-reply** for synced mail: the provider has its own, and Kite's would come from your Kite address.
- Mail you already read or starred at the provider (on your phone, say) arrives **read** or **starred**, and without a notification.
- A message Kite already has (the same Message-ID, for example one you imported, or one moved back into the Inbox at the provider) is not stored again.
- Kite checks only the Inbox, and only fetches each message once. Deleting, moving or reading a message at the provider afterwards changes nothing in Kite, and nothing you do in Kite changes the provider. A message deleted at the provider before Kite's next check never arrives. A message larger than 25 MB is skipped and named in the account's problems.
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

**Test connection** signs in with the saved password, at the saved server, and records the result; a working test makes a failed account **Connected** again. **Edit** changes the label, the mailbox or how often Kite checks at once. Changing the password, the user name, the provider or any server (IMAP or SMTP) needs the account's password again, your Kite password and a new successful test: Kite never sends a saved password to a server other than the one it was saved for. **Remove** forgets the account and its password and stops checking it at once; mail already imported or synced stays in Kite, and nothing changes at the provider. While you may not use connected accounts (above), **Remove** is the only thing that works.

## Security

- **Encrypted only.** Kite connects over TLS (port 993) or STARTTLS (port 143), checks the server's certificate and never sends a password over a plain connection. It refuses private and local addresses and ports other than 993, 143, 465 and 587. On the Node runtime it resolves the server's name itself and refuses it when any address is private (`EXTERNAL_ACCOUNTS_ALLOW_PRIVATE_HOSTS=1` allows a mail server on your LAN; see [Self-hosting](self-hosting.md)).
- **Sealed passwords.** The password is stored encrypted with `APP_ENCRYPTION_KEY` and never shown again, logged, sent in a webhook or written to an audit entry. Without the key, accounts cannot be connected at all.
- **Rate limit.** Each user gets 10 connection attempts (connect, test or reconnect) in 10 minutes. Every attempt counts, refused ones too, and the limit is checked before your Kite password or anything else, so the form cannot be used to guess passwords, probe addresses or scan servers. Provider detection has its own small per-user limit.
- **Backups** keep each account's settings but never its password. After a restore, every account shows **Sign-in failed** with "Reconnect after restore" until you reconnect it.
- **Audit.** Connecting, editing, removing, every connection test and admin changes are recorded in the audit log (`external_account.*`), with the account's address and server but never the password or user name. Checking for new mail records when it stops working and when it works again (`external_account.sync_failed`, `external_account.sync_recovered`), with the kind of problem only.

## For admins

- **Admin → General → Connected accounts → Allow connected accounts** turns the feature on or off for everyone. It is on by default when `APP_ENCRYPTION_KEY` is set, and off (and cannot be turned on) without it. Turning it off stops every account from being used: nothing signs in with them, no new mail is fetched or delivered, and they cannot be connected, edited, tested or imported from, only removed. They keep the state they had, under a notice that connected accounts are off. Their passwords stay for 30 days; then the daily 02:00 UTC run erases them and the accounts show **Password erased**. Turning it back on within the 30 days stops that.
- **Admin → Accounts → (account) → Permissions → Connected accounts** allows or forbids one user to connect accounts, and shows how many connected accounts the user has in which states (never which accounts, their passwords or mail). Taking the permission away stops that user's accounts the same way (working ones show **Paused**) and starts the same 30-day clock for every account that still holds a password, whatever its state; giving it back within the 30 days resumes them.
- A disabled Kite account's connected accounts are not checked either, and new mail is only delivered while the owner has full access to the chosen mailbox.
- Connected accounts need database migration 0079, and migration 0080 for **Other IMAP provider** addresses to stop reserving the address. Until 0079 is applied from the admin overview, the page says "Apply the pending database update to use connected accounts" and nothing is checked.
