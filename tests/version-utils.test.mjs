import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	changelogSection,
	checkReleaseBump,
	compareVersions,
	NO_CHANGES_NOTE,
	nextVersion,
	packageVersion,
	releaseChangelog,
} from "../scripts/version-utils.mjs";

test("the first release of a UTC day ends in .0 and later ones count up", () => {
	assert.equal(nextVersion("0.5.0.1", new Date("2026-10-09T12:00:00Z")), "2026.10.09.0");
	assert.equal(nextVersion("2026.10.08.3\n", new Date("2026-10-09T01:00:00+02:00")), "2026.10.08.4");
	assert.equal(nextVersion("2026.10.09.0", new Date("2026-10-09T23:59:59Z")), "2026.10.09.1");
	assert.equal(nextVersion("2026.10.09.9", new Date("2026-10-09T08:00:00Z")), "2026.10.09.10");
	assert.equal(nextVersion("2026.10.09.4", new Date("2026-11-01T00:00:00Z")), "2026.11.01.0");
});

test("a VERSION dated in the future is refused instead of going backwards", () => {
	assert.throws(() => nextVersion("2026.10.10.0", new Date("2026-10-09T12:00:00Z")), /dated after 2026\.10\.09/);
});

test("package.json gets the first three segments without leading zeros", () => {
	assert.equal(packageVersion("2026.10.09.1"), "2026.10.9");
	assert.equal(packageVersion("2027.01.02.0"), "2027.1.2");
	assert.equal(packageVersion("0.5.0.1"), "0.5.0");
	assert.throws(() => packageVersion("2026.10.09"), /four numeric segments/);
});

test("the committed package.json matches VERSION", () => {
	const version = readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim();
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(pkg.version, packageVersion(version));
});

test("releasing moves the Unreleased entries under the new version", () => {
	const changelog =
		"# Changelog\n\nIntro.\n\n## [Unreleased]\n\n### Added\n\n- New thing.\n\n## [2026.10.01.0] - 2026-10-01\n\n- Old.\n";
	assert.equal(
		releaseChangelog(changelog, "2026.10.09.0", new Date("2026-10-09T12:00:00Z")),
		"# Changelog\n\nIntro.\n\n## [Unreleased]\n\n## [2026.10.09.0] - 2026-10-09\n\n### Added\n\n- New thing.\n\n## [2026.10.01.0] - 2026-10-01\n\n- Old.\n",
	);
});

test("a release without Unreleased entries says there are no user-visible changes", () => {
	const day = new Date("2026-10-09T12:00:00Z");
	assert.equal(
		releaseChangelog(
			"# Changelog\n\n## [Unreleased]\n\n## [2026.10.01.0] - 2026-10-01\n\n- Old.\n",
			"2026.10.09.0",
			day,
		),
		"# Changelog\n\n## [Unreleased]\n\n## [2026.10.09.0] - 2026-10-09\n\nNo user-visible changes.\n\n## [2026.10.01.0] - 2026-10-01\n\n- Old.\n",
	);
	assert.equal(
		releaseChangelog("# Changelog\n\n## [Unreleased]\n\n### Added\n\n### Fixed\n\n", "2026.10.09.0", day),
		"# Changelog\n\n## [Unreleased]\n\n## [2026.10.09.0] - 2026-10-09\n\nNo user-visible changes.\n",
		"empty headings are dropped",
	);
	assert.equal(
		releaseChangelog("# Changelog\n\n## [Unreleased]\n", "2026.10.09.0", day),
		`# Changelog\n\n## [Unreleased]\n\n## [2026.10.09.0] - 2026-10-09\n\n${NO_CHANGES_NOTE}\n`,
		"Unreleased as the last line",
	);
});

test("releasing still needs an Unreleased section", () => {
	assert.throws(() => releaseChangelog("# Changelog\n", "2026.10.09.0"), /no "## \[Unreleased\]" section/);
});

test("calendar versions compare by day, then by the counter as a number", () => {
	assert.equal(compareVersions("2026.10.09.0", "2026.10.09.0"), 0);
	assert.equal(compareVersions("2026.10.09.1", "2026.10.09.0"), 1);
	assert.equal(compareVersions("2026.10.09.9", "2026.10.09.10"), -1);
	assert.equal(compareVersions("2026.10.10.0", "2026.10.09.12"), 1);
	assert.equal(compareVersions("2026.09.30.5", "2026.10.01.0"), -1);
	assert.equal(compareVersions("2027.01.01.0\n", "2026.12.31.3"), 1);
	assert.throws(() => compareVersions("0.5.0.1", "2026.10.09.0"), /Not a calendar version: 0\.5\.0\.1/);
	assert.throws(() => compareVersions("2026.10.09.0", "v2026.10.09.1"), /Not a calendar version: v2026/);
});

test("a release section is the text up to the next release heading", () => {
	const changelog =
		"# Changelog\n\n## [Unreleased]\n\n## [2026.10.09.1] - 2026-10-09\n\nNote.\n\n### Fixed\n\n- A fix.\n\n## [2026.10.09.0] - 2026-10-09\n\n- First.\n";
	assert.equal(changelogSection(changelog, "2026.10.09.1"), "Note.\n\n### Fixed\n\n- A fix.");
	assert.equal(changelogSection(changelog, "2026.10.09.0"), "- First.");
	assert.equal(changelogSection(changelog, "Unreleased"), "");
	assert.equal(changelogSection(changelog, "2026.10.09.2"), null);
	assert.equal(changelogSection(changelog, "2026.10.09"), null, "a prefix is not a heading");
	assert.equal(changelogSection(changelog, "2026x10.09.1"), null, "dots are literal");
});

const released = (version, extra = "") =>
	`# Changelog\n\n## [Unreleased]\n${extra}\n## [${version}] - 2026-10-22\n\n- Thing.\n\n## [2026.10.22.0] - 2026-10-22\n\n- Old.\n`;

test("a branch that bumps VERSION and releases its changelog passes", () => {
	assert.deepEqual(
		checkReleaseBump({
			baseVersion: "2026.10.22.0\n",
			headVersion: "2026.10.22.1\n",
			changelog: released("2026.10.22.1"),
		}),
		[],
	);
	assert.deepEqual(
		checkReleaseBump({ baseVersion: "0.5.0.1", headVersion: "2026.10.22.1", changelog: released("2026.10.22.1") }),
		[],
		"a pre-calendar base is older than any calendar version",
	);
	assert.deepEqual(
		checkReleaseBump({
			baseVersion: "2026.10.22.0",
			headVersion: "2026.10.22.1",
			changelog: released("2026.10.22.1", "\n### Added\n"),
		}),
		[],
		"empty headings under Unreleased are not entries",
	);
});

test("an unbumped, invalid or unreleased branch reports each problem", () => {
	const unchanged = checkReleaseBump({
		baseVersion: "2026.10.22.0",
		headVersion: "2026.10.22.0",
		changelog: "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- A fix.\n\n## [2026.10.22.0] - 2026-10-22\n\n- Old.\n",
	});
	assert.equal(unchanged.length, 2);
	assert.match(unchanged[0], /2026\.10\.22\.0 is not newer than 2026\.10\.22\.0/);
	assert.match(unchanged[1], /entries under Unreleased/);

	const older = checkReleaseBump({
		baseVersion: "2026.10.22.1",
		headVersion: "2026.10.22.0",
		changelog: released("2026.10.22.0"),
	});
	assert.deepEqual(older, ["VERSION 2026.10.22.0 is not newer than 2026.10.22.1 on the base branch"]);

	const noHeading = checkReleaseBump({
		baseVersion: "2026.10.22.0",
		headVersion: "2026.10.22.1",
		changelog: released("2026.10.22.2"),
	});
	assert.deepEqual(noHeading, ['CHANGELOG.md has no "## [2026.10.22.1]" heading']);

	const invalid = checkReleaseBump({
		baseVersion: "2026.10.22.0",
		headVersion: "2026.10.22",
		changelog: released("2026.10.22.1"),
	});
	assert.equal(invalid.length, 2);
	assert.match(invalid[0], /2026\.10\.22 is not a calendar version/);

	const empty = checkReleaseBump({ baseVersion: "2026.10.22.0", headVersion: "", changelog: released("2026.10.22.1") });
	assert.deepEqual(empty, ["VERSION (empty) is not a calendar version YYYY.MM.DD.N"]);
});
