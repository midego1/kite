import { escapeIcsText, formatIcsLocal, formatIcsUtc, joinIcsLines } from "./ics-utils";
import { parseCalendarRepeatDays, parseExcludedOccurrences } from "./recurrence";
import { buildVtimezone } from "./vtimezone-utils";
import type { FeedEvent, FeedOptions } from "./feed-types";

const BYDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
/** How far ahead each VTIMEZONE describes the zone's offset changes. */
const VTIMEZONE_YEARS_AHEAD = 10;
const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** How the event's times are written: in UTC, as wall-clock times in a zone, or as whole dates. */
type Timing = { kind: "utc" } | { kind: "zoned"; zone: string } | { kind: "date"; zone: string };

function validTimeZone(value: string | null | undefined): string | null {
	if (!value) return null;
	try {
		return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
	} catch {
		return null;
	}
}

function isLocalMidnight(value: Date, zone: string): boolean {
	return formatIcsLocal(value, zone).endsWith("T000000");
}

function weekdayIn(value: Date, zone: string): number {
	return WEEKDAY_INDEX[new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short" }).format(value)] ?? 0;
}

/**
 * All-day invitations are stored as local midnight to local midnight, so an event that starts and ends on a
 * midnight is written as whole dates. A recurring event keeps its wall-clock time across daylight saving changes
 * only when it carries its zone; a one-off timed event is unambiguous in UTC.
 */
function timingFor(event: FeedEvent, ownerZone: string): Timing {
	const zone = validTimeZone(event.timeZone) ?? ownerZone;
	if (event.endsAt > event.startsAt && isLocalMidnight(event.startsAt, zone) && isLocalMidnight(event.endsAt, zone))
		return { kind: "date", zone };
	if (event.repeat === "none" || zone === "UTC") return { kind: "utc" };
	return { kind: "zoned", zone };
}

function dateProperty(name: string, value: Date, timing: Timing): string {
	if (timing.kind === "date") return `${name};VALUE=DATE:${formatIcsLocal(value, timing.zone).slice(0, 8)}`;
	if (timing.kind === "zoned") return `${name};TZID=${timing.zone}:${formatIcsLocal(value, timing.zone)}`;
	return `${name}:${formatIcsUtc(value)}`;
}

/** Kite stops a series before `repeatUntil`; UNTIL is inclusive, so it names the last instant still allowed. */
function untilValue(repeatUntil: Date, timing: Timing): string {
	const last = new Date(repeatUntil.getTime() - 1000);
	return timing.kind === "date" ? formatIcsLocal(last, timing.zone).slice(0, 8) : formatIcsUtc(last);
}

/** BYMONTHDAY for Kite's monthly rule, which moves the 29th to the 31st to the month's last day when it is shorter. */
function monthDayRule(anchor: number): string {
	if (anchor <= 28) return `BYMONTHDAY=${anchor}`;
	const days = Array.from({ length: anchor - 27 }, (_, index) => 28 + index);
	return `BYMONTHDAY=${days.join(",")};BYSETPOS=-1`;
}

function recurrenceParts(event: FeedEvent, timing: Timing, days: number[]): string[] {
	if (event.repeat === "daily") return ["FREQ=DAILY"];
	if (event.repeat === "weekly") return ["FREQ=WEEKLY"];
	if (event.repeat === "weekdays") return ["FREQ=WEEKLY", `BYDAY=${days.map((day) => BYDAY[day]).join(",")}`];
	const zone = timing.kind === "utc" ? "UTC" : timing.zone;
	const anchor = event.repeatAnchorDay ?? Number(formatIcsLocal(event.startsAt, zone).slice(6, 8));
	return ["FREQ=MONTHLY", monthDayRule(anchor)];
}

/** The RRULE and EXDATE lines of a series, or `null` for a series that has no occurrence at all. */
function recurrenceLines(event: FeedEvent, timing: Timing): string[] | null {
	if (event.repeat === "none") return [];
	const days = parseCalendarRepeatDays(event.repeatDays);
	if (event.repeat === "weekdays" && days.length === 0) return null;
	const parts = recurrenceParts(event, timing, days);
	if (event.repeatUntil) parts.push(`UNTIL=${untilValue(event.repeatUntil, timing)}`);
	const excluded = new Set(parseExcludedOccurrences(event.excludedOccurrences));
	// DTSTART always counts as an occurrence in iCalendar, while Kite skips a first day that is not one of the weekdays.
	const zone = timing.kind === "utc" ? "UTC" : timing.zone;
	if (event.repeat === "weekdays" && !days.includes(weekdayIn(event.startsAt, zone)))
		excluded.add(event.startsAt.getTime());
	return [
		`RRULE:${parts.join(";")}`,
		...[...excluded].sort((a, b) => a - b).map((time) => dateProperty("EXDATE", new Date(time), timing)),
	];
}

function eventLines(event: FeedEvent, timing: Timing, stamp: string): string[] {
	const recurrence = recurrenceLines(event, timing);
	if (!recurrence) return [];
	const lines = [
		"BEGIN:VEVENT",
		`UID:${event.id}@kite`,
		`DTSTAMP:${stamp}`,
		dateProperty("DTSTART", event.startsAt, timing),
		dateProperty("DTEND", event.endsAt, timing),
		`SUMMARY:${escapeIcsText(event.title)}`,
		`STATUS:${event.status === "tentative" ? "TENTATIVE" : "CONFIRMED"}`,
	];
	if (event.description) lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
	if (event.location) lines.push(`LOCATION:${escapeIcsText(event.location)}`);
	lines.push(...recurrence);
	if (event.updatedAt) lines.push(`LAST-MODIFIED:${formatIcsUtc(event.updatedAt)}`);
	lines.push("END:VEVENT");
	return lines;
}

/**
 * One VTIMEZONE per zone a TZID names, from the start of the year of the zone's earliest event to
 * VTIMEZONE_YEARS_AHEAD years after now. Subscribers refetch the feed, so the window moves with it.
 */
function timeZoneLines(planned: { event: FeedEvent; timing: Timing }[], now: Date): string[] {
	const earliest = new Map<string, number>();
	for (const { event, timing } of planned) {
		if (timing.kind !== "zoned") continue;
		earliest.set(timing.zone, Math.min(earliest.get(timing.zone) ?? Infinity, event.startsAt.getTime()));
	}
	const end = Date.UTC(now.getUTCFullYear() + VTIMEZONE_YEARS_AHEAD, 0, 1);
	return [...earliest].flatMap(([zone, first]) =>
		buildVtimezone(zone, Date.UTC(new Date(first).getUTCFullYear(), 0, 1), end),
	);
}

/** A read-only iCalendar document (METHOD:PUBLISH) of the owner's events, for subscribing from another calendar app. */
export function buildCalendarFeed(events: FeedEvent[], options: FeedOptions): string {
	const ownerZone = validTimeZone(options.timeZone) ?? "UTC";
	const now = options.now ?? new Date();
	const stamp = formatIcsUtc(now);
	const planned = events.map((event) => ({ event, timing: timingFor(event, ownerZone) }));
	const lines = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Kite//Calendar feed//EN",
		"CALSCALE:GREGORIAN",
		"METHOD:PUBLISH",
		`X-WR-CALNAME:${escapeIcsText(options.name)}`,
		`X-WR-TIMEZONE:${ownerZone}`,
		"REFRESH-INTERVAL;VALUE=DURATION:PT1H",
		"X-PUBLISHED-TTL:PT1H",
		...timeZoneLines(planned, now),
	];
	for (const { event, timing } of planned) lines.push(...eventLines(event, timing, stamp));
	lines.push("END:VCALENDAR");
	return joinIcsLines(lines);
}
