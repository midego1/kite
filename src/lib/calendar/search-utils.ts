import { buildFtsMatch, parseSearchQuery } from "@/lib/search/query-utils";

/** Event search reads the free text only: mail operators such as `from:` or `has:` mean nothing for events. */
export function calendarSearchMatch(query: string): string | null {
	const { text } = parseSearchQuery(query);
	return text ? buildFtsMatch({ text, needsFullText: true }) : null;
}

function startLabel(startsAt: Date, timeZone: string): string {
	const format = (zone: string) =>
		new Intl.DateTimeFormat("en-US", {
			weekday: "short",
			month: "short",
			day: "numeric",
			hour: "numeric",
			minute: "2-digit",
			timeZone: zone,
		}).format(startsAt);
	try {
		return format(timeZone);
	} catch {
		return format("UTC");
	}
}

/** "Mon, Apr 1, 9:00 AM · Room 4": when the event starts for the viewer, then where. */
export function calendarSearchSublabel(startsAt: Date, timeZone: string, location: string): string {
	const place = location.trim();
	return place ? `${startLabel(startsAt, timeZone)} · ${place}` : startLabel(startsAt, timeZone);
}
