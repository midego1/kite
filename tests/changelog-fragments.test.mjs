import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import {
	foldFragments,
	foldUnreleased,
	fragmentProblems,
	isFragmentFile,
	parseFragment,
	readFragments,
} from "../scripts/changelog-fragments.mjs";
import {
	changelogSection,
	checkPullRequest,
	hasPendingChanges,
	isReleaseBranch,
	NO_CHANGES_NOTE,
	releaseChangelog,
	unreleasedChangelog,
} from "../scripts/version-utils.mjs";

const CHANGELOG = `# Changelog

Preamble.

## [Unreleased]

## [2026.10.27.2] - 2026-10-27

### Fixed

- An older fix.
`;
const fixed = { name: "reader-scroll.md", text: "### Fixed\n\n- The reader keeps its place.\n" };
const added = {
	name: "digest.md",
	text: "### Added\n\n- A daily digest.\n  It wraps onto a second line.\n\n### Fixed\n\n- The digest link works.\n",
};
const day = new Date("2026-10-28T09:00:00Z");

test("a fragment is one or more known ### sections with entries", () => {
	assert.deepEqual(parseFragment(added.text, added.name), {
		sections: [
			{ title: "Added", body: "- A daily digest.\n  It wraps onto a second line." },
			{ title: "Fixed", body: "- The digest link works." },
		],
		problems: [],
	});
	assert.deepEqual(parseFragment("### Security\r\n\r\nA paragraph note.\r\n", "note.md").problems, []);
});

test("malformed fragments are reported with their file name", () => {
	const problems = (text, name = "x.md") => parseFragment(text, name).problems;
	assert.match(problems("- no heading\n")[0], /x\.md: text before the first "### Section" heading/);
	assert.match(problems("")[0], /add a "### Section" heading/);
	assert.match(problems("### Improved\n\n- Something.\n")[0], /"### Improved" is not one of Added, Changed/);
	assert.match(problems("### Fixed\n\n")[0], /"### Fixed" has no entries/);
	assert.match(problems("## [2026.10.28.0]\n### Fixed\n- x\n")[0], /only "### Section" headings are allowed/);
	assert.match(problems("### Fixed\n- x\n#### Detail\n")[0], /found "#### Detail"/);
	assert.match(problems("### Fixed\n- x\n", "My Change.md")[0], /My Change\.md: name it with lowercase/);
	assert.deepEqual(fragmentProblems([fixed, added]), []);
	assert.equal(fragmentProblems([fixed, { name: "bad.md", text: "" }]).length, 1);
});

test("code blocks may hold heading-like lines and entries may start with #123", () => {
	const fenced = "### Fixed\n\n- Run this:\n\n  ```sh\n  # not a heading\n  ```\n\n~~~\n#### still code\n~~~\n";
	assert.deepEqual(parseFragment(fenced, "fenced.md").problems, []);
	assert.match(parseFragment(fenced, "fenced.md").sections[0].body, /# not a heading/);
	assert.deepEqual(parseFragment("### Fixed\n\n#123 The reader keeps its place.\n", "issue.md").problems, []);
	assert.deepEqual(parseFragment("### Fixed\n\n````\n```\n## [x]\n````\n", "nested.md").problems, [
		'nested.md: "## [x]" would start a new release, even in a code block',
	]);
	assert.deepEqual(parseFragment("### Fixed\n\n```\n- open\n", "open.md").problems, [
		"open.md: a code block opened with ``` is never closed",
	]);
	assert.deepEqual(parseFragment("intro\nmore intro\n### Fixed\n- x\n", "intro.md").problems, [
		'intro.md: text before the first "### Section" heading',
	]);
});

test("a release is due for fragments or for entries still under Unreleased", () => {
	assert.equal(hasPendingChanges(CHANGELOG, []), false);
	assert.equal(hasPendingChanges(CHANGELOG, [fixed]), true);
	assert.equal(hasPendingChanges(CHANGELOG.replace("## [Unreleased]\n", "## [Unreleased]\n\n- Legacy.\n"), []), true);
	assert.equal(hasPendingChanges("# Changelog\n", []), false);
});

test("README.md and non-Markdown files in changelog.d are not fragments", () => {
	assert.equal(isFragmentFile("README.md"), false);
	assert.equal(isFragmentFile(".gitkeep"), false);
	assert.equal(isFragmentFile("reader-scroll.md"), true);
});

test("fragments fold into one heading per section in Keep a Changelog order", () => {
	assert.equal(
		foldFragments([fixed, added]),
		"### Added\n\n- A daily digest.\n  It wraps onto a second line.\n\n### Fixed\n\n- The reader keeps its place.\n- The digest link works.",
	);
	assert.equal(foldFragments([]), "");
});

test("entries still under Unreleased merge with the fragments", () => {
	assert.equal(
		foldUnreleased("\n### Fixed\n\n- A legacy entry.\n", [fixed]),
		"### Fixed\n\n- A legacy entry.\n- The reader keeps its place.",
	);
	assert.equal(foldUnreleased("A loose note.", [fixed]), "A loose note.\n\n### Fixed\n\n- The reader keeps its place.");
	assert.equal(foldUnreleased("\n\n", []), "");
});

test("a release folds the fragments under the new version and leaves Unreleased empty", () => {
	const released = releaseChangelog(CHANGELOG, "2026.10.28.0", day, [fixed, added]);
	assert.equal(
		released,
		`# Changelog

Preamble.

## [Unreleased]

## [2026.10.28.0] - 2026-10-28

### Added

- A daily digest.
  It wraps onto a second line.

### Fixed

- The reader keeps its place.
- The digest link works.

## [2026.10.27.2] - 2026-10-27

### Fixed

- An older fix.
`,
	);
	assert.equal(changelogSection(releaseChangelog(CHANGELOG, "2026.10.28.0", day, []), "2026.10.28.0"), NO_CHANGES_NOTE);
});

test("the What's new bundle lists pending fragments under Unreleased", () => {
	const preview = unreleasedChangelog(CHANGELOG, [fixed]);
	assert.equal(changelogSection(preview, "Unreleased"), "### Fixed\n\n- The reader keeps its place.");
	assert.equal(changelogSection(preview, "2026.10.27.2"), "### Fixed\n\n- An older fix.");
	assert.equal(unreleasedChangelog(CHANGELOG, []), CHANGELOG);
});

test("the generated bundle includes the fragments in changelog.d", () => {
	execFileSync("node", ["scripts/generate-changelog-bundle.mjs"], { cwd: new URL("..", import.meta.url) });
	const { markdown } = JSON.parse(readFileSync(new URL("../public/changelog.json", import.meta.url), "utf8"));
	const fragments = readFragments(new URL("..", import.meta.url).pathname);
	assert.equal(changelogSection(markdown, "Unreleased"), foldFragments(fragments));
});

const directory = mkdtempSync(join(tmpdir(), "kite-fragments-"));
after(() => rmSync(directory, { recursive: true, force: true }));

test("readFragments reads changelog.d sorted by name and skips the README", () => {
	assert.deepEqual(readFragments(directory), []);
	mkdirSync(join(directory, "changelog.d"));
	writeFileSync(join(directory, "changelog.d", "README.md"), "# About\n");
	writeFileSync(join(directory, "changelog.d", "b.md"), fixed.text);
	writeFileSync(join(directory, "changelog.d", "a.md"), added.text);
	assert.deepEqual(
		readFragments(directory).map(({ name, text }) => ({ name, text })),
		[
			{ name: "a.md", text: added.text },
			{ name: "b.md", text: fixed.text },
		],
	);
});

const feature = {
	branch: "feat/digest",
	baseVersion: "2026.10.27.2\n",
	headVersion: "2026.10.27.2\n",
	changelog: CHANGELOG,
	fragments: [fixed],
	changedFragments: ["changelog.d/reader-scroll.md"],
};

test("a feature pull request passes with a fragment and leaves the release files alone", () => {
	assert.deepEqual(checkPullRequest(feature), []);
});

test("a feature pull request without a fragment needs the no-changelog label", () => {
	const missing = { ...feature, changedFragments: [] };
	assert.match(checkPullRequest(missing).join("\n"), /add a fragment in changelog\.d/);
	assert.deepEqual(checkPullRequest({ ...missing, labels: ["no-changelog"] }), []);
	assert.deepEqual(checkPullRequest({ ...missing, labels: ["no-changelog"], fragments: [] }), []);
});

test("a feature pull request may not bump VERSION, write under Unreleased or add a broken fragment", () => {
	const bumped = checkPullRequest({ ...feature, headVersion: "2026.10.28.0" });
	assert.match(bumped.join("\n"), /VERSION changed from 2026\.10\.27\.2 to 2026\.10\.28\.0/);
	const legacy = CHANGELOG.replace("## [Unreleased]\n", "## [Unreleased]\n\n- A legacy entry.\n");
	assert.match(checkPullRequest({ ...feature, changelog: legacy }).join("\n"), /move them to a fragment/);
	const broken = checkPullRequest({ ...feature, fragments: [fixed, { name: "Broken.md", text: "- x\n" }] });
	assert.equal(broken.length, 3);
});

test("a release pull request must fold every fragment into a newer version", () => {
	assert.equal(isReleaseBranch("release/next"), true);
	assert.equal(isReleaseBranch("feat/release-notes"), false);
	const released = releaseChangelog(CHANGELOG, "2026.10.28.0", day, [fixed]);
	const release = {
		branch: "release/next",
		baseVersion: "2026.10.27.2",
		headVersion: "2026.10.28.0\n",
		changelog: released,
		fragments: [],
		changedFragments: [],
	};
	assert.deepEqual(checkPullRequest(release), []);
	assert.match(checkPullRequest({ ...release, fragments: [fixed] }).join("\n"), /still has 1 fragment/);
	assert.match(checkPullRequest({ ...release, headVersion: "2026.10.27.2" }).join("\n"), /is not newer/);
});

test("the release workflow only pushes release/next and never main", () => {
	const yaml = readFileSync(new URL("../.github/workflows/release-pr.yml", import.meta.url), "utf8");
	const pushes = [...yaml.matchAll(/git push[^\n]*/g)].map((match) => match[0]);
	assert.deepEqual(pushes, ['git push "$remote" "$commit:refs/heads/release/next"']);
	assert.doesNotMatch(yaml, /--force|-f\b|\+refs\/|:refs\/heads\/main\b/);
	// main is the first parent, so the commit's own diff is only the release files.
	assert.match(yaml, /parents=\(-p HEAD\)/);
	// Only the publish job holds a write token, and it runs no npm.
	const publish = yaml.slice(yaml.indexOf("\n  publish:"));
	const prepare = yaml.slice(yaml.indexOf("\n  prepare:"), yaml.indexOf("\n  publish:"));
	assert.match(yaml, /^permissions: \{\}$/m);
	assert.doesNotMatch(prepare, /write/);
	assert.doesNotMatch(publish, /\bnpm (ci|install)\b|\bnode (scripts|--)|setup-node|node_modules/);
});
