# Changelog fragments

Every pull request with a user-visible change adds one file here instead of editing `CHANGELOG.md`, `VERSION` or the package versions. Unique file names mean open pull requests never conflict. The next release pull request folds every fragment into a new `CHANGELOG.md` section and deletes them; until then the **What's new in Kite** dialog lists them under "Unreleased changes". See [Releasing](../docs/releasing.md).

- Name it after the change, in lowercase letters, digits, `.`, `_` or `-`, ending in `.md`: for example `changelog.d/screener-digest.md`.
- Start with a `### Added`, `### Changed`, `### Deprecated`, `### Removed`, `### Fixed` or `### Security` heading, followed by entries written like the ones in `CHANGELOG.md`. One fragment may hold several headings; no other heading level is allowed, outside code blocks. An entry may start with an issue number such as `#123`.
- Write for the people using Kite: at most about two short sentences, plain words, what is different for them. No code identifiers or backticks, file names, environment variables, log events, HTTP codes, pull request mechanics or "No migration" notes; that detail belongs in the docs and the pull request body. CI fails an entry over 400 characters, with backticks or with a "No migration" note; a fragment that really needs one adds the line `<!-- changelog-style: technical-ok -->`. See [Writing entries](../docs/releasing.md#writing-entries).
- Something an operator has to act on (a database update to apply, a setting to change, "do not roll back") stays, in plain words, and links the docs page with the steps. Link a setting with an app path such as `[Settings → Notifications](/settings/notifications)`.
- A user-visible UI change adds a screenshot under its entry, `  ![what it shows](/changelog/<name>.webp)`: a WebP of at most 1600 px and 200 KB in `public/changelog/`, with demo data only (take it with `npm run changelog:screenshot`; see [Releasing](../docs/releasing.md#screenshots-in-the-changelog)).
- A change nobody can notice (CI, tests, refactoring) needs no fragment: give the pull request the `no-changelog` label instead.

```markdown
### Fixed

- Opening a long thread no longer scrolls the reader back to the top when new mail arrives.
```

The CI "Release version" check (`npm run release:check -- origin/main`) validates every fragment and fails a pull request that adds none without the label.
