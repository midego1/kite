### Fixed

- #150 Importing a folder with more than about 700,000 messages no longer stops because the server's list of messages is too long for one answer.

### Security

- #150 A mail server that keeps talking during sign-in now hits the same limit as during any other step of an import, instead of only the time limit.
