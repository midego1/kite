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

/** Moves the Unreleased entries under a heading for `version`, leaving an empty Unreleased section on top. */
export function releaseChangelog(changelog, version, date = new Date()) {
	const heading = "## [Unreleased]";
	const start = changelog.indexOf(`${heading}\n`);
	if (start === -1) throw new Error(`CHANGELOG.md has no "${heading}" section`);
	const bodyStart = start + heading.length + 1;
	const next = changelog.indexOf("\n## ", bodyStart);
	const body = changelog.slice(bodyStart, next === -1 ? undefined : next);
	if (!body.trim()) throw new Error("CHANGELOG.md has nothing under Unreleased to release");
	return `${changelog.slice(0, start)}${heading}\n\n## [${version}] - ${utcDay(date)}\n${changelog.slice(bodyStart)}`;
}
