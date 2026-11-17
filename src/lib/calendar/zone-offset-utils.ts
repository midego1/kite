/**
 * UTC offsets of IANA zones from the runtime's time zone data. Formatting an instant with Intl is slow next to
 * everything else a feed does, so the offset changes of each zone and year are found once and looked up after that.
 */

/** No zone changes its offset twice within a week, so the scan steps a week at a time and refines to the minute. */
const STEP_MS = 7 * 86_400_000;
const MINUTE_MS = 60_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
	let value = formatters.get(zone);
	if (!value) {
		value = new Intl.DateTimeFormat("en-US", {
			timeZone: zone,
			hourCycle: "h23",
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
			second: "numeric",
		});
		if (formatters.size >= 64) formatters.clear();
		formatters.set(zone, value);
	}
	return value;
}

/** The zone's offset from UTC at `time`, in minutes (east positive). */
export function zoneOffsetMinutes(time: number, zone: string): number {
	const parts = Object.fromEntries(
		formatter(zone)
			.formatToParts(new Date(time))
			.map((part) => [part.type, part.value]),
	);
	const wall = Date.UTC(
		Number(parts.year),
		Number(parts.month) - 1,
		Number(parts.day),
		Number(parts.hour),
		Number(parts.minute),
		Number(parts.second),
	);
	return Math.round((wall - Math.floor(time / 1000) * 1000) / MINUTE_MS);
}

export type ZoneTransition = { at: number; from: number; to: number };

/** The first minute at which the offset differs from the offset at `low`, given that it does by `high`. */
function transitionBetween(low: number, high: number, zone: string, before: number): number {
	let lo = low;
	let hi = high;
	while (hi - lo > MINUTE_MS) {
		const middle = lo + Math.floor((hi - lo) / 2 / MINUTE_MS) * MINUTE_MS;
		if (zoneOffsetMinutes(middle, zone) === before) lo = middle;
		else hi = middle;
	}
	return hi;
}

/** Every offset change in the zone between `start` and `end`, found week by week and refined to the minute. */
export function zoneTransitions(zone: string, start: number, end: number): ZoneTransition[] {
	const transitions: ZoneTransition[] = [];
	let time = start;
	let offset = zoneOffsetMinutes(time, zone);
	while (time < end) {
		const next = Math.min(time + STEP_MS, end);
		const nextOffset = zoneOffsetMinutes(next, zone);
		if (nextOffset !== offset) {
			transitions.push({ at: transitionBetween(time, next, zone, offset), from: offset, to: nextOffset });
			offset = nextOffset;
		}
		time = next;
	}
	return transitions;
}

const yearTables = new Map<string, { initial: number; transitions: ZoneTransition[] }>();

/** The zone's offset at `time` in minutes, from the cached offset changes of that year. */
function zoneOffsetAt(time: number, zone: string): number {
	const year = new Date(time).getUTCFullYear();
	// Before 1970 zones carried odd local mean times; ask Intl directly rather than tabulate them.
	if (year < 1970) return zoneOffsetMinutes(time, zone);
	const key = `${zone} ${year}`;
	let table = yearTables.get(key);
	if (!table) {
		const start = Date.UTC(year, 0, 1);
		table = {
			initial: zoneOffsetMinutes(start, zone),
			transitions: zoneTransitions(zone, start, Date.UTC(year + 1, 0, 1)),
		};
		if (yearTables.size >= 1024) yearTables.clear();
		yearTables.set(key, table);
	}
	let offset = table.initial;
	for (const transition of table.transitions) {
		if (time < transition.at) break;
		offset = transition.to;
	}
	return offset;
}

/** The wall clock at `time` in a fixed offset, as a date shifted so its UTC fields read as that wall clock. */
export function zonedWallClock(time: number, zone: string): Date {
	return new Date(time + zoneOffsetAt(time, zone) * MINUTE_MS);
}
