import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEvents } from "@/db/schema";
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

/** A calendar event is visible to the user whose calendar it is on, and to nobody else. */
export const resolveCalendarRefs: CapabilityHandler = async (input, ctx) => {
	const refs = refsOf(input);
	const userId = viewerId(ctx);
	const found = new Map<string, FoundRef>();
	if (userId) {
		const db = () => getDb(getEnv());
		await forEachIdChunk(idsOfKind(refs, "calendar:event"), async (chunk) => {
			const rows = await db()
				.select({ id: calendarEvents.id, title: calendarEvents.title, startsAt: calendarEvents.startsAt })
				.from(calendarEvents)
				.where(and(eq(calendarEvents.userId, userId), inArray(calendarEvents.id, chunk)));
			for (const row of rows)
				found.set(refKey("calendar:event", row.id), {
					href: calendarEventHref(row.id, row.startsAt, ctx.timeZone),
					label: row.title,
				});
		});
	}
	return refsOutput(refs, found);
};
