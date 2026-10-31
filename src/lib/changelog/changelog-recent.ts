import changelog from "./changelog-recent.json";
import { parseChangelog } from "./changelog-utils";
import type { ChangelogRelease } from "./types";

let releases: ChangelogRelease[] | null = null;

/**
 * The newest releases of the changelog this build ships (`scripts/generate-changelog-bundle.mjs`), parsed once
 * per isolate: `GET /api/version` picks the notes a tab on an older build has not had from them.
 */
export function loadRecentChangelogReleases(): ChangelogRelease[] {
	releases ??= parseChangelog(changelog.markdown);
	return releases;
}
