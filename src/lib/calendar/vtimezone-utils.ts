/**
 * VTIMEZONE components (RFC 5545 section 3.6.5) for the zones a feed names with TZID, derived from the runtime's
 * time zone data: every offset change between two instants becomes its own STANDARD or DAYLIGHT observance.
 */

import { zoneOffsetMinutes, zoneTransitions } from "./zone-offset-utils";

const MINUTE_MS = 60_000;

/** Built components per zone and range: every poll of a feed asks for the same ones. */
const built = new Map<string, string[]>();

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
