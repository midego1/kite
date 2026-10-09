import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { nextVersion, packageVersion, releaseChangelog } from "../scripts/version-utils.mjs";

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

test("releasing refuses a changelog with nothing unreleased", () => {
	assert.throws(
		() =>
			releaseChangelog("# Changelog\n\n## [Unreleased]\n\n## [2026.10.01.0] - 2026-10-01\n\n- Old.\n", "2026.10.09.0"),
		/nothing under Unreleased/,
	);
	assert.throws(
		() => releaseChangelog("# Changelog\n\n## [Unreleased]\n\n### Added\n\n### Fixed\n\n", "2026.10.09.0"),
		/nothing under Unreleased/,
		"headings without entries",
	);
	assert.throws(() => releaseChangelog("# Changelog\n", "2026.10.09.0"), /no "## \[Unreleased\]" section/);
});
