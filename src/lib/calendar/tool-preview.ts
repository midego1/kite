import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEvents } from "@/db/schema";
import { normalizeTimeZone } from "@/lib/time/utils";
import { calendarToolSchemas } from "./tool-schemas";
import { previewDeletions, previewUpdates } from "./tool-preview-utils";

export type CalendarPreviewTool = "update_events" | "delete_events";

/**
 * What a proposed `update_events` or `delete_events` call would touch, for the chat approval card: the viewer's
 * own events by title and start, and what changes. Refuses ids that are not the viewer's series, as the tool would.
 */
export async function previewCalendarToolChange(
	env: CloudflareEnv,
	viewer: { userId: string; timeZone: string },
	tool: CalendarPreviewTool,
	rawInput: unknown,
) {
	const timeZone = normalizeTimeZone(viewer.timeZone);
	const updates = tool === "update_events" ? calendarToolSchemas.update_events.parse(rawInput).updates : null;
	const ids = updates
		? updates.map((update) => update.eventId)
		: calendarToolSchemas.delete_events.parse(rawInput).eventIds;
	if (new Set(ids).size !== ids.length)
		throw new Error(`Use unique series IDs for ${updates ? "updates" : "deletion"}`);
	const rows = await getDb(env)
		.select({
			id: calendarEvents.id,
			title: calendarEvents.title,
			startsAt: calendarEvents.startsAt,
			repeat: calendarEvents.repeat,
		})
		.from(calendarEvents)
		.where(and(eq(calendarEvents.userId, viewer.userId), inArray(calendarEvents.id, ids)));
	const events = new Map(rows.map((row) => [row.id, row]));
	if (ids.some((id) => !events.has(id))) throw new Error("Event not found");
	return { items: updates ? previewUpdates(updates, events, timeZone) : previewDeletions(ids, events, timeZone) };
}
