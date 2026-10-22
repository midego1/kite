# Releasing

Kite uses calendar versions, `YYYY.MM.DD.N`: the UTC date a release was prepared, then a counter for that day's releases starting at 0. The first release on 9 October 2026 is `2026.10.09.0`, a second one that day is `2026.10.09.1`.

Every merge to `main` deploys production through the Cloudflare Git integration, so every merge is a release: each pull request ends with its own release commit, and the GitHub release is published automatically once the production deploy has succeeded.

## Version numbers

- `VERSION` holds the current release. Builds embed it with the short Git revision (`scripts/build-version.mjs`), so the sidebar and the database card show `Kite v2026.10.09.0 (985434d)`. MCP reports the same version and the OpenAPI document (`docs/openapi.json`) carries it as `info.version`.
- `package.json` and the root of `package-lock.json` carry the npm form: the first three parts without leading zeros (`2026.10.9`), because npm accepts neither four parts nor leading zeros. `npm run quality:check` fails when they disagree with `VERSION`.
- Because every merge bumps `VERSION`, each production deploy has its own version; the revision tells builds of the same release apart, such as a preview of a pull request.
- The number says when a release was made, not what changed in it. `CHANGELOG.md` says what needs attention, such as database migrations to apply from the admin overview, or a new variable or binding.
- The email relay (`deploy/cloudflare-email-relay`) keeps its own version.

## Releasing a pull request

1. Add your changelog entries under "Unreleased" in `CHANGELOG.md` as you work. A change nobody can notice (CI, tests, refactoring) needs none.
2. When the branch is otherwise ready, rebase it on an up-to-date `main` and run `npm run release:prepare` as the last commit of the branch. It writes the next version into `VERSION`, `package.json`, `package-lock.json` and `docs/openapi.json`, and moves the entries under "Unreleased" to a heading for the new version. With nothing under "Unreleased" the new release says "No user-visible changes." It refuses when `VERSION` is dated after today, and it commits, tags and pushes nothing.
3. Review the new changelog section. Name every migration and every setting an operator has to add or change. When a note introduces or changes something a user can set, link to the page it lives on with an app path, for example `[Settings → Inbox → Notifications](/settings/inbox)`: the **What's new in Kite** dialog opens such links in the app, while `https://` links open in a new tab and any other link stays plain text. `npm run release:notes -- <previous tag>` lists the commit subjects since the last release to compare against.
4. Commit as `chore(release): <version>` and push the branch. Nothing may follow that commit except another release commit.

The "Release version" job in `.github/workflows/ci.yml` runs `npm run release:check -- <base commit>` on every pull request (`scripts/release-check.mjs`, Node built-ins only). It fails when `VERSION` is not a calendar version newer than the base's, when `CHANGELOG.md` has no heading for it, or when entries are still under "Unreleased", because they would deploy without a release. Run `npm run release:check -- origin/main` locally for the same answer.

### When `main` moves first

Two open pull requests usually prepare the same next version, so the second one conflicts in `VERSION`, `package.json`, `package-lock.json`, `docs/openapi.json` and `CHANGELOG.md` once the first is merged. Rebase on `main`, and when Git stops at your release commit:

1. Take `main`'s side of those files: `git checkout --ours VERSION package.json package-lock.json docs/openapi.json CHANGELOG.md` (during a rebase, "ours" is `main`).
2. Put your own changelog entries back under "Unreleased" if they were in the release commit.
3. Run `npm run release:prepare` again and finish the rebase (`git add` the files, `git rebase --continue`). Your release now follows `main`'s, for example `2026.10.22.2` after `2026.10.22.1`.

Alternatively, drop the release commit before rebasing with `git reset --keep HEAD~1`, which puts your entries back under "Unreleased" (edits you made to the release section in that commit are lost), then rebase on `main` and run `npm run release:prepare` again.

## After the merge

Merging to `main` deploys the Worker through Cloudflare Workers Builds. When the `Workers Builds: kite` production check run succeeds, two workflows run:

- `.github/workflows/deploy-record.yml` records a GitHub deployment for the commit ([Operations](operations.md#after-a-deploy)).
- `.github/workflows/release-publish.yml` runs `scripts/deploy/release-publish.mjs` from the default branch. It reads `VERSION` at the deployed commit and creates the lightweight tag `v<version>` on that commit if it does not exist yet, then publishes the GitHub release "Kite `<version>`", marked as the latest. Its notes are the version's section of `CHANGELOG.md` followed by the commits since the previous `v*` tag, grouped into features, fixes and maintenance. A draft for the same tag is filled in and published instead of adding a second release; an already published release is never edited.

When the tag already exists on a different commit, the deploy did not bump `VERSION` (a pull request merged without its release commit). The workflow then makes no tag or release and leaves a warning on the run; prepare a new release in the next pull request.

Tags created by the workflow do not trigger other workflows. The Release draft workflow (`.github/workflows/release.yml`) is kept for manual use: run it from the Actions tab, or push a `v*` tag yourself, to get a draft release with notes grouped from the commit subjects. It leaves an already published release untouched and finishes successfully.

A release prepared on one day and merged on a later one keeps its version: the date is when it was prepared. Don't reuse or move a tag once the release is published; prepare a new release instead.
