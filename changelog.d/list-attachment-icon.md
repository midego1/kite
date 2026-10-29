### Added

- Message list rows with a real attachment now show a small paperclip next to the date, in the stacked and the wide row at every density. In conversation view the paperclip shows when any message in the conversation has one. An image that is only embedded in the message body (referenced by its content ID) does not count. `GET /api/messages` rows carry the new `hasAttachments` field.
