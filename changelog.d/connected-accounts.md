### Added

- **Connected accounts** under [Settings → Connected accounts](/settings/connected-accounts): connect a Gmail, Google Workspace, iCloud Mail, Yahoo, AOL, Fastmail or other IMAP account with an app password, and import its mail from [Settings → Import](/settings/import) without typing the password again (**Sign in with**, or **Import mail** on the account). Kite recognises the provider from the address or the domain's MX records, tests the sign-in before saving, asks for your Kite password again, stores the account's password encrypted with `APP_ENCRYPTION_KEY` and never shows it again. **Test connection**, **Edit**/**Reconnect** and **Remove** (the mail stays) are on each account. Outlook.com and Microsoft 365 need Microsoft sign-in and cannot be connected yet.
- Admins control the feature with **Allow connected accounts** under [Admin → General](/general) (on by default only when `APP_ENCRYPTION_KEY` is set) and per user under Admin → Accounts → Permissions, which also lists a user's connected accounts and their states. Passwords of accounts that may not be used for 30 days are erased by the daily run.
- Needs database migration **0079** (`0079_add_external_accounts.sql`), applied from the admin overview; until then the page asks for the database update.

### Security

- Connected account passwords are left out of backups; a restored account has to be reconnected. Connection tests are limited to 10 per user in 10 minutes, refuse private and local servers and ports other than 993, 143, 465 and 587, and are recorded in the audit log without the password or user name.
