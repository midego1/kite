import type { RecordRef } from "@/lib/modules/module-types";

/** Actions the Calendar module owns: their targets are calendar records, not the invitation mail. */
const CALENDAR_ACTIONS: readonly string[] = ["create_event", "delete_event", "send_rsvp"];

export function isCalendarAction(action: string): boolean {
	return CALENDAR_ACTIONS.includes(action);
}

/** The calendar event a calendar action created, changed or removed, when its row recorded one. */
export function calendarActionRef(row: { action: string; after: Record<string, unknown> | null }): RecordRef | null {
	const eventId = row.after?.eventId;
	return isCalendarAction(row.action) && typeof eventId === "string" && eventId
		? { kind: "calendar:event", id: eventId }
		: null;
}
