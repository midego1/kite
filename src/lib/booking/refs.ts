import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { bookingEvents, calendarEvents } from "@/db/schema";
import { bookingAppointments } from "@/db/schema/modules";
import { calendarEventHref } from "@/lib/calendar/event-link-utils";
import { getEnv } from "@/lib/cloudflare";
import {
	forEachIdChunk,
	idsOfKind,
	refKey,
	refsOf,
	refsOutput,
	viewerId,
	type FoundRef,
} from "@/lib/modules/handler-helpers";
import type { CapabilityHandler } from "@/lib/modules/module-types";

/**
 * An event type is visible to the user who owns it. An appointment is a calendar event a public
 * booking created, visible to the host whose calendar it is on.
 */
export const resolveBookingRefs: CapabilityHandler = async (input, ctx) => {
	const refs = refsOf(input);
	const userId = viewerId(ctx);
	const found = new Map<string, FoundRef>();
	if (userId) {
		const db = () => getDb(getEnv());
		await forEachIdChunk(idsOfKind(refs, "booking:event_type"), async (chunk) => {
			const rows = await db()
				.select({ id: bookingEvents.id, name: bookingEvents.name })
				.from(bookingEvents)
				.where(and(eq(bookingEvents.userId, userId), inArray(bookingEvents.id, chunk)));
			for (const row of rows)
				found.set(refKey("booking:event_type", row.id), {
					href: `/booking?event=${encodeURIComponent(row.id)}`,
					label: row.name,
				});
		});
		await forEachIdChunk(idsOfKind(refs, "booking:appointment"), async (chunk) => {
			const rows = await db()
				.select({ id: calendarEvents.id, title: calendarEvents.title, startsAt: calendarEvents.startsAt })
				.from(bookingAppointments)
				.innerJoin(calendarEvents, eq(calendarEvents.id, bookingAppointments.calendarEventId))
				.where(and(eq(calendarEvents.userId, userId), inArray(bookingAppointments.calendarEventId, chunk)));
			for (const row of rows)
				found.set(refKey("booking:appointment", row.id), {
					href: calendarEventHref(row.id, row.startsAt, ctx.timeZone),
					label: `Booked: ${row.title}`,
				});
		});
	}
	return refsOutput(refs, found);
};
