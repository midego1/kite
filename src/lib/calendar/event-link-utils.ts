/** The calendar day (YYYY-MM-DD) an instant falls on in a time zone; an unknown zone reads as UTC. */
function calendarDay(at: Date, timeZone: string): string {
	let parts: Intl.DateTimeFormatPart[];
	try {
		parts = new Intl.DateTimeFormat("en-CA", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		}).formatToParts(at);
	} catch {
		return calendarDay(at, "UTC");
	}
	const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
	return `${part("year")}-${part("month")}-${part("day")}`;
}

/** The calendar page opened on an event's day with the event selected. */
export function calendarEventHref(id: string, startsAt: Date, timeZone: string): string {
	return `/calendar?date=${calendarDay(startsAt, timeZone)}&event=${encodeURIComponent(id)}`;
}
