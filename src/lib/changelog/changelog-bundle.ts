import changelog from "./changelog.json";
import { parseChangelog } from "./changelog-utils";
import type { ChangelogRelease } from "./types";

/**
 * The CHANGELOG.md that `scripts/generate-changelog-bundle.mjs` embedded at
 * build time, parsed on demand: the "What's new" dialog imports this module
 * when it first opens, so the release notes stay out of the page bundle.
 */
export function loadChangelogReleases(): ChangelogRelease[] {
	return parseChangelog(changelog.markdown);
}
