### Fixed

- A message with a very large calendar file attached is stored and opens normally, unless the file has an extreme number of lines. The file stays attached as it was sent, and only calendar files of normal size become invitations.
- Received mail is processed at most ten messages at a time, so the first sync of a connected account no longer overloads the database. Mail that arrives during such a sync can take a little longer to appear.
