# Connected accounts

A connected account is a mail account at another provider (Gmail, Google Workspace, iCloud Mail, Yahoo Mail, AOL Mail, Fastmail or any other IMAP provider) whose sign-in Kite keeps, so you can bring its mail into Kite without typing the password each time. Kite only reads from the account; it never deletes, moves or marks anything there.

Today a connected account is the source of imports: **Import mail** copies the account's existing mail into Kite in the background (see [Importing a whole account](modules.md#importing-a-whole-account)). Checking the account for new mail and sending as its address are planned next (the design is [External mail accounts](specs/external-accounts.md)).

## Connect an account

1. Open **Settings → Connected accounts** (`/settings/connected-accounts`) and choose **Connect account**.
2. Enter the account's email address. Kite recognises the provider from the address (`gmail.com`, `icloud.com`, `yahoo.co.uk`, …) or, for your own domain, from where its MX records point (Google Workspace, Microsoft 365, iCloud+ custom domains, Fastmail). Check the **Provider**, or choose **Other IMAP provider** and enter the IMAP server, port and encryption yourself (the SMTP server is optional and only stored for later). With a known provider Kite signs in with the address itself, so the sign-in proves the address; only **Other IMAP provider** accepts a different user name.
3. Enter the password. Most providers need an **app password** for mail apps once two-step sign-in is on; the dialog says where to make one:
   - Gmail: Google Account → Security → 2-Step Verification → App passwords. Google Workspace: the same, if your Workspace admin allows app passwords.
   - iCloud Mail: Apple Account → Sign-In and Security → App-Specific Passwords.
   - Yahoo and AOL: Account Security → Generate app password.
   - Fastmail: Settings → Privacy & Security → Manage app passwords.
4. Choose **Mail goes to**: the Kite mailbox the account's mail is imported into. You need full access to it. If others can read that mailbox, the dialog says so: everyone with access to it will see the account's mail.
5. Enter **your Kite password** again. Kite asks for it because it is about to store another account's password.
6. **Connect.** Kite signs in to the account and opens its Inbox read-only. Only when that works is the account saved. Whether an address is already connected in this Kite is checked only after that sign-in, so nobody learns it without the account's password.

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

**Test connection** signs in with the saved password, at the saved server, and records the result. **Edit** changes the label or the mailbox at once. Changing the password, the user name, the provider or any server (IMAP or SMTP) needs the account's password again, your Kite password and a new successful test: Kite never sends a saved password to a server other than the one it was saved for. **Remove** forgets the account and its password at once; mail already imported stays in Kite, and nothing changes at the provider. While you may not use connected accounts (above), **Remove** is the only thing that works.

## Security

- **Encrypted only.** Kite connects over TLS (port 993) or STARTTLS (port 143), checks the server's certificate and never sends a password over a plain connection. It refuses private and local addresses and ports other than 993, 143, 465 and 587. On the Node runtime it resolves the server's name itself and refuses it when any address is private (`EXTERNAL_ACCOUNTS_ALLOW_PRIVATE_HOSTS=1` allows a mail server on your LAN; see [Self-hosting](self-hosting.md)).
- **Sealed passwords.** The password is stored encrypted with `APP_ENCRYPTION_KEY` and never shown again, logged, sent in a webhook or written to an audit entry. Without the key, accounts cannot be connected at all.
- **Rate limit.** Each user gets 10 connection attempts (connect, test or reconnect) in 10 minutes. Every attempt counts, refused ones too, and the limit is checked before your Kite password or anything else, so the form cannot be used to guess passwords, probe addresses or scan servers. Provider detection has its own small per-user limit.
- **Backups** keep each account's settings but never its password. After a restore, every account shows **Sign-in failed** with "Reconnect after restore" until you reconnect it.
- **Audit.** Connecting, editing, removing, every connection test and admin changes are recorded in the audit log (`external_account.*`), with the account's address and server but never the password or user name.

## For admins

- **Admin → General → Connected accounts → Allow connected accounts** turns the feature on or off for everyone. It is on by default when `APP_ENCRYPTION_KEY` is set, and off (and cannot be turned on) without it. Turning it off stops every account from being used: nothing signs in with them, and they cannot be connected, edited, tested or imported from, only removed. They keep the state they had, under a notice that connected accounts are off. Their passwords stay for 30 days; then the daily 02:00 UTC run erases them and the accounts show **Password erased**. Turning it back on within the 30 days stops that.
- **Admin → Accounts → (account) → Permissions → Connected accounts** allows or forbids one user to connect accounts, and shows how many connected accounts the user has in which states (never which accounts, their passwords or mail). Taking the permission away stops that user's accounts the same way (working ones show **Paused**) and starts the same 30-day clock for every account that still holds a password, whatever its state; giving it back within the 30 days resumes them.
- Connected accounts need database migration 0079. Until it is applied from the admin overview, the page says "Apply the pending database update to use connected accounts".
