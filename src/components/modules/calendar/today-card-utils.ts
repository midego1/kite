import type { CalendarEvent } from "@/app/(calendar)/calendar/types";
import { calendarEventHref } from "@/lib/calendar/event-link-utils";
import type { TodayLines } from "./today-card-types";

/**
 * The events the Today card lists, at most.
 * @public Test-only: used inside this file, exported for tests.
 */
export const TODAY_MAX_LINES = 4;

/**
 * "30 min", "1 h", "1 h 30 min", or "All day" for a day or longer.
 * @public Test-only: used inside this file, exported for tests.
 */
export function durationText(startsAt: string, endsAt: string): string {
	const minutes = Math.max(0, Math.round((Date.parse(endsAt) - Date.parse(startsAt)) / 60_000));
	if (minutes >= 24 * 60) return "All day";
	if (minutes < 60) return `${minutes} min`;
	const rest = minutes % 60;
	return rest ? `${Math.floor(minutes / 60)} h ${rest} min` : `${minutes / 60} h`;
}

/**
 * Today's events that are not over yet at `now`, from occurrences already expanded for the day ending at
 * `dayEnd`, earliest first: under way ones say "Now", the rest their start time in `timeZone`.
 */
export function todayLines(
	occurrences: readonly CalendarEvent[],
	{ now, dayEnd, timeZone, max = TODAY_MAX_LINES }: { now: Date; dayEnd: Date; timeZone: string; max?: number },
): TodayLines {
	const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone });
	const today = occurrences.filter((event) => Date.parse(event.startsAt) < dayEnd.getTime());
	const left = today
		.filter((event) => Date.parse(event.endsAt) > now.getTime())
		.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
	return {
		lines: left.slice(0, max).map((event) => {
			const startsAt = new Date(event.startsAt);
			return {
				id: event.id,
				when: startsAt <= now ? "Now" : time.format(startsAt),
				what: event.title,
				meta: event.location.trim() || durationText(event.startsAt, event.endsAt),
				href: calendarEventHref(event.id, startsAt, timeZone),
			};
		}),
		more: Math.max(0, left.length - max),
		empty: today.length > 0 ? "Nothing else today" : "Nothing today",
	};
}
