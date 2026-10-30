import type { z } from "zod";
import { startLabel } from "./search-utils";
import type { calendarUpdateSchema } from "./tool-schemas";

type PreviewEvent = { title: string; startsAt: Date; repeat: string };
type PreviewItem = { label: string; detail: string | null };

const REPEAT_NAMES: Record<string, string> = {
	none: "does not repeat",
	daily: "repeats daily",
	weekly: "repeats weekly",
	monthly: "repeats monthly",
	weekdays: "repeats on chosen weekdays",
};

/** "Team sync · Mon, Apr 1, 9:00 AM": which event a proposed change touches, as the user knows it. */
function eventLabel(event: PreviewEvent, timeZone: string): string {
	return `${event.title} · ${startLabel(event.startsAt, timeZone)}`.slice(0, 300);
}

function quoted(value: string, max = 80): string {
	const text = value.trim();
	return `“${text.length > max ? `${text.slice(0, max - 1)}…` : text}”`;
}

/** What an update changes, field by field, in the viewer's zone: the approval card's detail line. */
function describeEventUpdate(update: z.infer<typeof calendarUpdateSchema>, timeZone: string): string {
	const changes: string[] = [];
	if (update.title !== undefined) changes.push(`title ${quoted(update.title)}`);
	if (update.startsAt) changes.push(`starts ${startLabel(new Date(update.startsAt), timeZone)}`);
	if (update.endsAt) changes.push(`ends ${startLabel(new Date(update.endsAt), timeZone)}`);
	if (update.location !== undefined)
		changes.push(update.location.trim() ? `location ${quoted(update.location)}` : "no location");
	if (update.description !== undefined) changes.push("new description");
	if (update.timeZone !== undefined) changes.push(`time zone ${update.timeZone}`);
	if (update.repeat !== undefined) changes.push(REPEAT_NAMES[update.repeat] ?? update.repeat);
	else if (update.repeatDays !== undefined) changes.push("new repeat days");
	if (update.attendees !== undefined)
		changes.push(update.attendees.length ? `attendees ${update.attendees.join(", ")}` : "no attendees");
	if (update.color !== undefined) changes.push("new colour");
	return (changes.length ? `Change: ${changes.join("; ")}` : "No fields change").slice(0, 1_000);
}

/** The approval lines for an update: each event as it is now, then what would change (whole series). */
export function previewUpdates(
	updates: z.infer<typeof calendarUpdateSchema>[],
	events: Map<string, PreviewEvent>,
	timeZone: string,
): PreviewItem[] {
	return updates.map((update) => {
		const event = events.get(update.eventId)!;
		const series = event.repeat !== "none" ? " (every occurrence)" : "";
		return { label: eventLabel(event, timeZone), detail: `${describeEventUpdate(update, timeZone)}${series}` };
	});
}

/** The approval lines for a deletion: each event, and a warning when the whole series goes. */
export function previewDeletions(ids: string[], events: Map<string, PreviewEvent>, timeZone: string): PreviewItem[] {
	return ids.map((id) => {
		const event = events.get(id)!;
		return {
			label: eventLabel(event, timeZone),
			detail:
				event.repeat !== "none" ? `Deletes every occurrence (${REPEAT_NAMES[event.repeat] ?? event.repeat})` : null,
		};
	});
}
