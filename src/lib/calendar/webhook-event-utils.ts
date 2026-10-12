import { buildCallContext } from "@/lib/modules/capability-utils";
import type { CapabilityCallContext, JsonValue } from "@/lib/modules/module-types";

export type CalendarWebhookKind = "created" | "updated" | "deleted";

/** The webhook event the Calendar module declares for each kind of write. */
export const CALENDAR_WEBHOOK_EVENTS: Record<CalendarWebhookKind, string> = {
	created: "calendar.event.created",
	updated: "calendar.event.updated",
	deleted: "calendar.event.deleted",
};

/** The columns of a stored event a payload needs. */
export type CalendarWebhookRow = {
	id: string;
	title: string;
	startsAt: Date;
	endsAt: Date;
	timeZone?: string | null;
};

export type CalendarWebhookUser = { id: string; role: string; isPrimaryAdmin: boolean; timeZone?: string | null };

/** The ref plus the minimal record of one event (spec §11.5); the schema is the descriptor's `inputSchema`. */
export function calendarEventWebhookPayload(row: CalendarWebhookRow): JsonValue {
	return {
		ref: { kind: "calendar:event", id: row.id },
		event: {
			id: row.id,
			title: row.title,
			start: row.startsAt.toISOString(),
			end: row.endsAt.toISOString(),
			timeZone: row.timeZone ?? "UTC",
		},
	};
}

/** The call context an event write carries: the acting user is the viewer, so their webhooks receive the event. */
export function calendarWebhookContext(
	user: CalendarWebhookUser,
	trigger: CapabilityCallContext["trigger"],
): CapabilityCallContext {
	return buildCallContext({
		trigger,
		viewer: { userId: user.id, role: user.role, isPrimaryAdmin: user.isPrimaryAdmin },
		timeZone: user.timeZone ?? "UTC",
	});
}
