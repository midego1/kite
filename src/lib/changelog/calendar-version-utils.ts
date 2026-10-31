const CALENDAR_VERSION = /^(\d{4})\.(\d{2})\.(\d{2})\.(\d+)$/;

export function isCalendarVersion(version: string): boolean {
	return CALENDAR_VERSION.test(version.trim());
}

/**
 * Orders two calendar versions (`YYYY.MM.DD.N`) part by part as numbers, so `.10` follows `.4`: negative when `a`
 * is older, positive when it is newer, zero when equal. Null when either is not a calendar version (a development
 * build), which callers treat as "cannot tell".
 */
export function compareCalendarVersions(a: string, b: string): number | null {
	const left = CALENDAR_VERSION.exec(a.trim());
	const right = CALENDAR_VERSION.exec(b.trim());
	if (!left || !right) return null;
	for (let part = 1; part <= 4; part += 1) {
		const difference = Number(left[part]) - Number(right[part]);
		if (difference !== 0) return Math.sign(difference);
	}
	return 0;
}
