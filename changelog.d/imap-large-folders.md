### Fixed

- #150 Importing a folder of up to a million messages (four million when self-hosted) no longer stops because the server's list of messages is too long for one answer.

### Security

- #150 A mail server now has the same limit during sign-in as in any other step of an import, and one folder's list of messages has a limit of its own.
