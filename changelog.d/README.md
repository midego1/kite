# Changelog fragments

Every pull request with a user-visible change adds one file here instead of editing `CHANGELOG.md`, `VERSION` or the package versions. Unique file names mean open pull requests never conflict. The next release pull request folds every fragment into a new `CHANGELOG.md` section and deletes them; until then the **What's new in Kite** dialog lists them under "Unreleased changes". See [Releasing](../docs/releasing.md).

- Name it after the change, in lowercase letters, digits, `.`, `_` or `-`, ending in `.md`: for example `changelog.d/screener-digest.md`.
- Start with a `### Added`, `### Changed`, `### Deprecated`, `### Removed`, `### Fixed` or `### Security` heading, followed by entries written like the ones in `CHANGELOG.md`. One fragment may hold several headings; no other heading level is allowed, outside code blocks. An entry may start with an issue number such as `#123`.
- Name every migration and every setting an operator has to add or change, and link a setting with an app path such as `[Settings → Notifications](/settings/notifications)`.
- A change nobody can notice (CI, tests, refactoring) needs no fragment: give the pull request the `no-changelog` label instead.

```markdown
### Fixed

- Opening a long thread no longer scrolls the reader back to the top when new mail arrives.
```

The CI "Release version" check (`npm run release:check -- origin/main`) validates every fragment and fails a pull request that adds none without the label.
