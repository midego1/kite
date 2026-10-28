### Changed

- IMAP imports keep the source's read and starred state: mail read there is read in Kite, and flagged mail is starred. Mail without a `Date` header gets the date the source server received it instead of the time of the import. Uploaded `.eml` and `.mbox` files arrive unread, as before.
- Imports skip a message the mailbox already holds whether its Message-ID was stored with angle brackets or without, so importing a provider's Sent folder no longer adds copies of mail sent from Kite. A message without a Message-ID is recognised by a SHA-256 hash of its bytes, so running an import again only adds what is missing. Messages imported without a Message-ID before this release were keyed differently and can be added once more by a re-run.

### Fixed

- Imported conversations no longer split when a reply is imported before the message it answers: the reply joins the conversation of the first message its `References` header names. Received mail is grouped as before.
