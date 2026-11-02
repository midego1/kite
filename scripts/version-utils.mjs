import { ENTRY, foldUnreleased, fragmentProblems } from "./changelog-fragments.mjs";

const CALENDAR_VERSION = /^(\d{4}\.\d{2}\.\d{2})\.(\d+)$/;

function utcDay(date) {
	return date.toISOString().slice(0, 10);
}

/**
 * The release after `current` prepared on `date`: `YYYY.MM.DD.N` for the UTC day, with N counting
 * that day's releases from 0. Anything that is not a calendar version (the pre-Kite `0.5.0.1`)
 * simply starts the day at 0.
 */
export function nextVersion(current, date = new Date()) {
	const day = utcDay(date).replaceAll("-", ".");
	const match = CALENDAR_VERSION.exec(current.trim());
	if (match && match[1] > day) throw new Error(`VERSION ${current.trim()} is dated after ${day}`);
	return match?.[1] === day ? `${day}.${Number(match[2]) + 1}` : `${day}.0`;
}

/** npm rejects four segments and leading zeros, so package.json carries the first three as plain numbers. */
export function packageVersion(version) {
	if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) throw new Error(`VERSION ${version} must have four numeric segments`);
	return version.split(".").slice(0, 3).map(Number).join(".");
}

const UNRELEASED_HEADING = "## [Unreleased]";

/** Text written under a release that has no Unreleased entries, so every deploy can still be a release. */
export const NO_CHANGES_NOTE = "No user-visible changes.";

/** Where the Unreleased section's body starts and ends, or null when CHANGELOG.md has no such section. */
function unreleasedSection(changelog) {
	const start = changelog.indexOf(`${UNRELEASED_HEADING}\n`);
	if (start === -1) return null;
	const bodyStart = start + UNRELEASED_HEADING.length + 1;
	const next = changelog.indexOf("\n## ", bodyStart);
	const bodyEnd = next === -1 ? changelog.length : next;
	return { start, bodyStart, bodyEnd, body: changelog.slice(bodyStart, bodyEnd) };
}

/**
 * Moves the Unreleased entries and the pending changelog.d fragments under a heading for `version`,
 * leaving an empty Unreleased section on top. Without entries the new release says NO_CHANGES_NOTE, and
 * empty `###` headings are dropped. Deleting the fragment files is the caller's job.
 */
export function releaseChangelog(changelog, version, date = new Date(), fragments = []) {
	const section = unreleasedSection(changelog);
	if (!section) throw new Error(`CHANGELOG.md has no "${UNRELEASED_HEADING}" section`);
	const before = `${changelog.slice(0, section.start)}${UNRELEASED_HEADING}\n\n## [${version}] - ${utcDay(date)}\n`;
	if (!fragments.length && ENTRY.test(section.body)) return `${before}${changelog.slice(section.bodyStart)}`;
	const body = foldUnreleased(section.body, fragments) || NO_CHANGES_NOTE;
	return `${before}\n${body}\n${changelog.slice(section.bodyEnd)}`;
}

/**
 * CHANGELOG.md as the "What's new" dialog shows it: the pending fragments listed under "Unreleased",
 * because every merge to main deploys them before the next release names them.
 */
export function unreleasedChangelog(changelog, fragments) {
	const section = unreleasedSection(changelog);
	if (!section || !fragments.length) return changelog;
	const body = foldUnreleased(section.body, fragments);
	if (!body) return changelog;
	return `${changelog.slice(0, section.bodyStart)}\n${body}\n${changelog.slice(section.bodyEnd)}`;
}

function parseCalendarVersion(version) {
	const match = CALENDAR_VERSION.exec(String(version).trim());
	if (!match) return null;
	return { day: match[1], counter: Number(match[2]) };
}

export function isCalendarVersion(version) {
	return parseCalendarVersion(version) !== null;
}

/** Orders two calendar versions by day, then by the day's counter as a number (so .10 follows .9). */
export function compareVersions(a, b) {
	const left = parseCalendarVersion(a);
	const right = parseCalendarVersion(b);
	if (!left || !right) throw new Error(`Not a calendar version: ${left ? b : a}`);
	if (left.day !== right.day) return left.day < right.day ? -1 : 1;
	return Math.sign(left.counter - right.counter);
}

function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The notes of one release: the text between its `## [<version>]` heading and the next `## [` heading, or null. */
export function changelogSection(changelog, version) {
	const heading = new RegExp(`^## \\[${escapeRegExp(version)}\\][^\\n]*\\n?`, "m").exec(changelog);
	if (!heading) return null;
	const bodyStart = heading.index + heading[0].length;
	const next = changelog.slice(bodyStart).search(/^## \[/m);
	return changelog.slice(bodyStart, next === -1 ? undefined : bodyStart + next).trim();
}

/**
 * Problems that stop a branch from being merged as its own release: the version must be a new calendar
 * version above the base's, CHANGELOG.md must have its heading, and nothing may be left under Unreleased.
 * A base that is not a calendar version (the pre-Kite `0.5.0.1`) is older than any calendar version.
 */
export function checkReleaseBump({ baseVersion, headVersion, changelog }) {
	const problems = [];
	const head = String(headVersion).trim();
	const base = String(baseVersion).trim();
	if (!parseCalendarVersion(head)) {
		problems.push(`VERSION ${head || "(empty)"} is not a calendar version YYYY.MM.DD.N`);
	} else if (parseCalendarVersion(base) && compareVersions(head, base) <= 0) {
		problems.push(`VERSION ${head} is not newer than ${base} on the base branch`);
	}
	if (head && changelogSection(changelog, head) === null) {
		problems.push(`CHANGELOG.md has no "## [${head}]" heading`);
	}
	const unreleased = unreleasedSection(changelog);
	if (unreleased && ENTRY.test(unreleased.body)) {
		problems.push("CHANGELOG.md still has entries under Unreleased; they would deploy without a release");
	}
	return problems;
}

/** The label that lets a pull request without user-visible changes skip the fragment. */
export const NO_CHANGELOG_LABEL = "no-changelog";

/** Release pull requests come from `release/*` branches; the release workflow keeps `release/next`. */
export function isReleaseBranch(branch) {
	return /^release\//.test(String(branch ?? ""));
}

/**
 * Problems that stop a pull request from merging. A release pull request (a `release/*` branch) must be a
 * complete release with every fragment folded in. Any other pull request leaves VERSION and the
 * Unreleased section alone and adds or edits a valid fragment in changelog.d, unless it carries the
 * `no-changelog` label; that keeps open pull requests from conflicting on the release files.
 */
export function checkPullRequest({
	branch,
	labels = [],
	baseVersion,
	headVersion,
	changelog,
	fragments,
	changedFragments,
	root,
}) {
	const problems = fragmentProblems(fragments, { root });
	if (isReleaseBranch(branch)) {
		problems.push(...checkReleaseBump({ baseVersion, headVersion, changelog }));
		if (fragments.length) {
			problems.push(`changelog.d still has ${fragments.length} fragment(s); run npm run release:prepare again`);
		}
		return problems;
	}
	if (String(headVersion).trim() !== String(baseVersion).trim()) {
		problems.push(
			`VERSION changed from ${String(baseVersion).trim()} to ${String(headVersion).trim()}; only the release pull request changes it, so take the base's VERSION, package.json, package-lock.json, docs/openapi.json and CHANGELOG.md`,
		);
	}
	const unreleased = unreleasedSection(changelog);
	if (unreleased && ENTRY.test(unreleased.body)) {
		problems.push('CHANGELOG.md has entries under "Unreleased"; move them to a fragment in changelog.d');
	}
	if (!changedFragments.length && !labels.includes(NO_CHANGELOG_LABEL)) {
		problems.push(
			`add a fragment in changelog.d (see changelog.d/README.md), or the "${NO_CHANGELOG_LABEL}" label when nobody can notice the change`,
		);
	}
	return problems;
}

/** Whether a release is due: fragments are waiting, or entries are still under "Unreleased" in CHANGELOG.md. */
export function hasPendingChanges(changelog, fragments) {
	const unreleased = unreleasedSection(changelog);
	return fragments.length > 0 || Boolean(unreleased && ENTRY.test(unreleased.body));
}
