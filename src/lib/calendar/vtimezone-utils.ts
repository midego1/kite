/**
 * VTIMEZONE components (RFC 5545 section 3.6.5) for the zones a feed names with TZID, derived from the runtime's
 * time zone data: every offset change between two instants becomes its own STANDARD or DAYLIGHT observance.
 */

/** No zone changes its offset twice within a week, so the scan steps a week at a time and refines to the minute. */
const STEP_MS = 7 * 86_400_000;
const MINUTE_MS = 60_000;
const formatters = new Map<string, Intl.DateTimeFormat>();
/** Built components per zone and range: every poll of a feed asks for the same ones. */
const built = new Map<string, string[]>();

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
function zoneOffsetMinutes(time: number, zone: string): number {
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

type Transition = { at: number; from: number; to: number };

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
function zoneTransitions(zone: string, start: number, end: number): Transition[] {
	const transitions: Transition[] = [];
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

/** A UTC offset as RFC 5545 writes it: `+0100`, `-0430`. */
function formatIcsOffset(minutes: number): string {
	const sign = minutes < 0 ? "-" : "+";
	const absolute = Math.abs(minutes);
	return `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}${String(absolute % 60).padStart(2, "0")}`;
}

/** The wall-clock time at `time` in a fixed offset, as a local DATE-TIME. */
function wallTime(time: number, offset: number): string {
	return new Date(time + offset * MINUTE_MS)
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "");
}

function observance(kind: "STANDARD" | "DAYLIGHT", start: string, from: number, to: number): string[] {
	return [
		`BEGIN:${kind}`,
		`DTSTART:${start}`,
		`TZOFFSETFROM:${formatIcsOffset(from)}`,
		`TZOFFSETTO:${formatIcsOffset(to)}`,
		`END:${kind}`,
	];
}

/**
 * The VTIMEZONE for `zone` covering `start` to `end`: the offset in force at `start`, then one observance per change.
 * A change to a larger offset is DAYLIGHT, to a smaller one STANDARD; a zone without changes has a single STANDARD.
 */
export function buildVtimezone(zone: string, start: number, end: number): string[] {
	const key = `${zone} ${start} ${end}`;
	const cached = built.get(key);
	if (cached) return cached;
	const lines = describeZone(zone, start, end);
	if (built.size >= 256) built.clear();
	built.set(key, lines);
	return lines;
}

function describeZone(zone: string, start: number, end: number): string[] {
	const initial = zoneOffsetMinutes(start, zone);
	const transitions = zoneTransitions(zone, start, end);
	const smallest = Math.min(initial, ...transitions.map((item) => item.to));
	const lines = ["BEGIN:VTIMEZONE", `TZID:${zone}`];
	lines.push(...observance(initial > smallest ? "DAYLIGHT" : "STANDARD", wallTime(start, initial), initial, initial));
	for (const item of transitions)
		lines.push(
			...observance(item.to > item.from ? "DAYLIGHT" : "STANDARD", wallTime(item.at, item.from), item.from, item.to),
		);
	lines.push("END:VTIMEZONE");
	return lines;
}
