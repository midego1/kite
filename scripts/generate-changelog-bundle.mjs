import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readFragments } from "./changelog-fragments.mjs";
import { unreleasedChangelog } from "./version-utils.mjs";

const root = new URL("../", import.meta.url);

/**
 * Ships CHANGELOG.md with the app so the "What's new" dialog can render it, with the pending
 * changelog.d fragments under "Unreleased": they deploy with every merge to main, before the next
 * release names them. Like the migration bundle the JSON is generated, not committed: every build,
 * development and typecheck command runs this before loading application code.
 */
const markdown = unreleasedChangelog(
	readFileSync(new URL("CHANGELOG.md", root), "utf8"),
	readFragments(fileURLToPath(root)),
);
const directory = fileURLToPath(new URL("src/lib/changelog/", root));
mkdirSync(directory, { recursive: true });
writeFileSync(
	fileURLToPath(new URL("src/lib/changelog/changelog.json", root)),
	`${JSON.stringify({ markdown }, null, 2)}\n`,
);
