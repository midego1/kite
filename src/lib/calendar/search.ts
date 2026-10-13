import { isNoSuchTableError } from "@/lib/modules/state-utils";
import { calendarEventHref } from "./event-link-utils";
import { calendarSearchMatch, calendarSearchSublabel } from "./search-utils";

export type CalendarSearchItem = {
	ref: { kind: "calendar:event"; id: string };
	label: string;
	sublabel: string;
	href: string;
};

type SearchOptions = { userId: string; timeZone: string; query: string; limit: number; now?: Date };
type EventRow = { id: string; title: string; location: string; starts_at: number };

/**
 * The viewer's own events matching the free text of `query`, nearest to now first. A database that has
 * not applied the migration with the index has nothing to search, which is an empty answer, not a failure.
 */
export async function searchCalendarEvents(
	env: Pick<CloudflareEnv, "DB">,
	{ userId, timeZone, query, limit, now = new Date() }: SearchOptions,
): Promise<CalendarSearchItem[]> {
	const match = calendarSearchMatch(query);
	if (!match) return [];
	let rows: EventRow[];
	try {
		const result = await env.DB.prepare(
			`SELECT id, title, location, starts_at FROM calendar_events
			WHERE user_id = ? AND rowid IN (SELECT rowid FROM calendar_events_fts WHERE calendar_events_fts MATCH ?)
			ORDER BY ABS(starts_at - ?), starts_at, id
			LIMIT ?`,
		)
			.bind(userId, match, Math.floor(now.getTime() / 1000), limit)
			.all<EventRow>();
		rows = result.results;
	} catch (error) {
		if (isNoSuchTableError(error)) return [];
		throw error;
	}
	return rows.map((row) => {
		const startsAt = new Date(row.starts_at * 1000);
		return {
			ref: { kind: "calendar:event", id: row.id },
			label: row.title,
			sublabel: calendarSearchSublabel(startsAt, timeZone, row.location),
			href: calendarEventHref(row.id, startsAt, timeZone),
		};
	});
}
