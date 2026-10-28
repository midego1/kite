### Fixed

- IMAP imports no longer accept an impossible receipt date from the source server (minute 60, a zone offset of 99 hours, a year before 1970); such a message keeps its `Date` header or the time of the import.
- An imported message dated more than a day in the future, by its `Date` header or by the source server, is dated by the next believable date (the server's receipt date, else the time of the import), so a source can no longer pin mail to the top of the list.
