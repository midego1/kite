# Releasing

Kite uses calendar versions, `YYYY.MM.DD.N`: the UTC date a release was prepared, then a counter for that day's releases starting at 0. The first release on 9 October 2026 is `2026.10.09.0`, a second one that day is `2026.10.09.1`.

## Version numbers

- `VERSION` holds the current release. Builds embed it with the short Git revision (`scripts/build-version.mjs`), so the sidebar and the database card show `Kite v2026.10.09.0 (985434d)`. MCP reports the same version and the OpenAPI document (`docs/openapi.json`) carries it as `info.version`.
- `package.json` and the root of `package-lock.json` carry the npm form: the first three parts without leading zeros (`2026.10.9`), because npm accepts neither four parts nor leading zeros. `npm run quality:check` fails when they disagree with `VERSION`.
- A build between releases shows the last release with its own revision, so the revision is what identifies a deploy.
- The number says when a release was made, not what changed in it. `CHANGELOG.md` says what needs attention, such as database migrations to apply from the admin overview, or a new variable or binding.
- The email relay (`deploy/cloudflare-email-relay`) keeps its own version.

## Cutting a release

1. On a branch from an up-to-date `main`, run `npm run release:prepare`. It writes the next version into `VERSION`, `package.json` and `package-lock.json`, and moves the entries under "Unreleased" in `CHANGELOG.md` to a heading for the new version. It refuses when "Unreleased" is empty, or when `VERSION` is dated after today. It commits, tags and pushes nothing.
2. Review the new changelog section. Name every migration and every setting an operator has to add or change. `npm run release:notes -- <previous tag>` lists the commit subjects since the last release to compare against.
3. Commit as `chore(release): <version>`, open a pull request and merge it. Merging to `main` deploys the Worker through the Cloudflare Git integration.
4. Tag the merge commit and push only the tag:

   ```bash
   git tag v<version> <merge commit>
   git push origin v<version>
   ```

5. The Release draft workflow (`.github/workflows/release.yml`) checks that the tag matches `VERSION`, then creates a draft GitHub release named "Kite `<version>`" with notes grouped from the commit subjects. Replace or extend the notes with the changelog section, then publish the release.

A release prepared on one day and merged on a later one keeps its version: the date is when it was prepared. Don't reuse or move a tag once the release is published; prepare a new release instead.
