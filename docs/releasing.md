# Releasing

Kite uses calendar versions, `YYYY.MM.DD.N`: the UTC date a release was prepared, then a counter for that day's releases starting at 0. The first release on 9 October 2026 is `2026.10.09.0`, a second one that day is `2026.10.09.1`.

Every merge to `main` deploys production through the Cloudflare Git integration, but not every merge is a named release. Pull requests describe their changes in changelog fragments (`changelog.d/`) and leave the version alone, so open pull requests never conflict on release files. A release pull request, kept up to date by a workflow, folds the fragments into `CHANGELOG.md` and bumps the version; merging it is the release, and the GitHub release is published automatically once its production deploy has succeeded.

## Version numbers

- `VERSION` holds the current release. Builds embed it with the short Git revision (`scripts/build-version.mjs`), so the sidebar and the database card show `Kite v2026.10.09.0 (985434d)`. MCP reports the same version and the OpenAPI document (`docs/openapi.json`) carries it as `info.version`.
- `package.json` and the root of `package-lock.json` carry the npm form: the first three parts without leading zeros (`2026.10.9`), because npm accepts neither four parts nor leading zeros. `npm run quality:check` fails when they disagree with `VERSION`.
- Deploys between two releases keep the last release's version; the revision tells them apart, as it does for a preview of a pull request.
- The number says when a release was made, not what changed in it. `CHANGELOG.md` says what needs attention, such as database migrations to apply from the admin overview, or a new variable or binding.
- The email relay (`deploy/cloudflare-email-relay`) keeps its own version.

## Changelog fragments

A pull request with a user-visible change adds a file to `changelog.d/`, named after the change: `changelog.d/<short-slug>.md` in lowercase letters, digits, `.`, `_` or `-`. It holds one or more `### Added`, `### Changed`, `### Deprecated`, `### Removed`, `### Fixed` or `### Security` headings, each followed by entries written as in `CHANGELOG.md`; no other heading level and no text before the first heading. [`changelog.d/README.md`](../changelog.d/README.md) has an example.

- Name every migration and every setting an operator has to add or change. When a note introduces or changes something a user can set, link to the page it lives on with an app path, for example `[Settings → Inbox → Notifications](/settings/inbox)`: the **What's new in Kite** dialog opens such links in the app, while `https://` links open in a new tab and any other link stays plain text.
- A change nobody can notice (CI, tests, refactoring) needs no fragment: label the pull request `no-changelog`.
- Do not edit `VERSION`, the package versions, `docs/openapi.json`'s version or the "Unreleased" section of `CHANGELOG.md`; only release pull requests do.
- Fragments ship with every deploy: the **What's new in Kite** dialog lists them under "Unreleased changes" (`scripts/generate-changelog-bundle.mjs`) until a release names them.

The "Changelog" job (`.github/workflows/changelog.yml`, which reruns when labels change) runs `npm run release:check -- <base commit>` (`scripts/release-check.mjs`, Node built-ins only). For an ordinary pull request it fails when no fragment was added or edited and the `no-changelog` label is missing, when any fragment in `changelog.d/` is malformed, when `VERSION` differs from the base's or when `CHANGELOG.md` has entries under "Unreleased". A pull request from a `release/*` branch must instead be a complete release: `VERSION` a calendar version newer than the base's, a `CHANGELOG.md` heading for it, nothing under "Unreleased" and no fragments left. Run `npm run release:check -- origin/main` locally for the same answer (it uses the current branch name; set `PR_LABELS='["no-changelog"]'` to mimic the label).

## Releasing

After every push to `main` that leaves fragments in `changelog.d/`, `.github/workflows/release-pr.yml` prepares the next release on top of `main` and opens or updates one pull request, "Release `<version>`", from the branch `release/next`:

1. It runs `npm run release:prepare`, which writes the next version into `VERSION`, `package.json`, `package-lock.json` and `docs/openapi.json`, folds the fragments (and anything still under "Unreleased") into a new `CHANGELOG.md` section with one heading per group, and deletes the fragments. It refuses malformed fragments and a `VERSION` dated after today, and it commits, tags and pushes nothing itself.
2. It commits the result as `chore(release): <version>` with `main` and the previous `release/next` as parents, so the branch only moves forward and the pull request's diff is exactly the release. It never pushes to `main`.
3. It dispatches CI, the documentation contract, the security scans and the changelog check on `release/next`, because pushes made with the workflow's `GITHUB_TOKEN` start no pull request runs by themselves.

Merge the release pull request whenever you want a named release. Its notes can be edited on the branch before merging; the next push to `main` with fragments prepares the pull request again and replaces such edits, so edit just before merging. `npm run release:notes -- <previous tag>` lists the commit subjects since the last release to compare against. GitHub deletes `release/next` after the merge, and the next fragment starts a new one.

To release by hand instead, run `npm run release:prepare` on a branch named `release/<anything>` made from an up-to-date `main`, commit as `chore(release): <version>` and open a pull request.

### Migrating an open PR

Pull requests opened before fragments ended with a `chore(release)` commit. To move one over:

1. Save the pull request's own changelog entries (the section its release commit added, or its lines under "Unreleased"); step 3 needs them.
2. Bring the branch up to date with `main` (merge or rebase); wherever Git reports a conflict in `VERSION`, `package.json`, `package-lock.json`, `docs/openapi.json` or `CHANGELOG.md`, take `main`'s side. Then put the release files back to `main`'s: `git checkout origin/main -- VERSION CHANGELOG.md`, the same for `package.json` and `package-lock.json` unless the pull request changes dependencies (then only their `version` fields go back to `main`'s), and `npm run docs:generate` to rewrite `docs/openapi.json` with `main`'s version.
3. Put the saved entries into a fragment, `changelog.d/<short-slug>.md`, keeping their `###` headings.
4. Commit, push and check with `npm run release:check -- origin/main`.

## After the merge

Merging to `main` deploys the Worker through Cloudflare Workers Builds. When the `Workers Builds: kite` production check run succeeds, two workflows run:

- `.github/workflows/deploy-record.yml` records a GitHub deployment for the commit ([Operations](operations.md#after-a-deploy)).
- `.github/workflows/release-publish.yml` runs `scripts/deploy/release-publish.mjs` from the default branch. It reads `VERSION` at the deployed commit and creates the lightweight tag `v<version>` on that commit if it does not exist yet, then publishes the GitHub release "Kite `<version>`", marked as the latest only when no higher published calendar version exists (drafts and prereleases do not count). Its notes are the version's section of `CHANGELOG.md` followed by the commits since the previous `v*` tag, grouped into features, fixes and maintenance. A draft for the same tag is filled in and published instead of adding a second release; an already published release is never edited.

When the tag already exists on a different commit, the deploy did not bump `VERSION`: an ordinary merge between two releases. The workflow then makes no tag or release and says so in its log; the next release pull request publishes the changes.

Tags created by the workflow do not trigger other workflows. The Release draft workflow (`.github/workflows/release.yml`) is kept for manual use: run it from the Actions tab, or push a `v*` tag yourself, to get a draft release with notes grouped from the commit subjects. It leaves an already published release untouched and finishes successfully.

A release prepared on one day and merged on a later one keeps its version: the date is when it was prepared (the release workflow prepares it again, with the current date, after every push to `main` with fragments). Don't reuse or move a tag once the release is published; prepare a new release instead.
