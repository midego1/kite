### Added

- Connected accounts can send as addresses their sign-in does not prove: an **Other IMAP provider** account's own address, an account whose user name is not its address, and provider aliases. In [Settings → Connected accounts](/settings/connected-accounts), **Verify** or **Send from another address** mails a 6-digit code to the address; once it is entered, the address is in the composer's From menu and mail from it goes out through the account's SMTP server. Codes work for 30 minutes and 5 tries, are stored only as a keyed hash, and are limited to 5 an hour per user (3 for one address) and 10 a day per address; an address with 10 wrong codes in a day gets no new code until the next day. Needs migration 0089 (`external_identities`), applied from the admin overview.

### Changed

- An unverified connected address is now listed in the From menu as **(Verify in Settings)** instead of being left out, and connecting or testing an account also tests its SMTP sign-in when its user name is not its address.
