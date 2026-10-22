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
// Paragraph notes count as entries too; blank lines and headings alone do not.
const ENTRY = /^[ \t]*[^#\s]/m;

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
 * Moves the Unreleased entries under a heading for `version`, leaving an empty Unreleased section on top.
 * Without entries the new release says NO_CHANGES_NOTE, and empty `###` headings are dropped.
 */
export function releaseChangelog(changelog, version, date = new Date()) {
	const section = unreleasedSection(changelog);
	if (!section) throw new Error(`CHANGELOG.md has no "${UNRELEASED_HEADING}" section`);
	const before = `${changelog.slice(0, section.start)}${UNRELEASED_HEADING}\n\n## [${version}] - ${utcDay(date)}\n`;
	if (ENTRY.test(section.body)) return `${before}${changelog.slice(section.bodyStart)}`;
	return `${before}\n${NO_CHANGES_NOTE}\n${changelog.slice(section.bodyEnd)}`;
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
