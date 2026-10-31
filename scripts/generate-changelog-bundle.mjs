import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readFragments } from "./changelog-fragments.mjs";
import { unreleasedChangelog } from "./version-utils.mjs";

const root = new URL("../", import.meta.url);

/** How many releases below "Unreleased" the server keeps for the "Kite was updated" notes. */
const RECENT_RELEASES = 4;

/** The changelog down to the RECENT_RELEASES-th release, so the server does not carry the whole history. */
function recentChangelog(changelog) {
	const headings = [...changelog.matchAll(/^## /gm)];
	const end = headings[RECENT_RELEASES + 1]?.index;
	return end === undefined ? changelog : changelog.slice(0, end);
}

/**
 * Ships CHANGELOG.md with the app so the "What's new" dialog can render it, with the pending
 * changelog.d fragments under "Unreleased": they deploy with every merge to main, before the next
 * release names them. Like the migration bundle the JSON is generated, not committed: every build,
 * development and typecheck command runs this before loading application code. The whole changelog is
 * the static asset `public/changelog.json`, which the dialog fetches when it opens, so release notes
 * never count toward the client JavaScript. `changelog-recent.json` holds only the newest releases, for
 * the notes `GET /api/version` sends to a tab on an older build.
 */
const markdown = unreleasedChangelog(
	readFileSync(new URL("CHANGELOG.md", root), "utf8"),
	readFragments(fileURLToPath(root)),
);
mkdirSync(fileURLToPath(new URL("src/lib/changelog/", root)), { recursive: true });
mkdirSync(fileURLToPath(new URL("public/", root)), { recursive: true });
writeFileSync(fileURLToPath(new URL("public/changelog.json", root)), `${JSON.stringify({ markdown })}\n`);
writeFileSync(
	fileURLToPath(new URL("src/lib/changelog/changelog-recent.json", root)),
	`${JSON.stringify({ markdown: recentChangelog(markdown) }, null, 2)}\n`,
);
