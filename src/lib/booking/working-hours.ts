import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { bookingEvents } from "@/db/schema";
import { workingHoursOf, type WorkingHours } from "./working-hours-utils";

/** The hours of the user's oldest enabled event type, or null when they have none. */
export async function loadWorkingHours(env: CloudflareEnv, userId: string): Promise<WorkingHours | null> {
	const [row] = await getDb(env)
		.select({
			weekdays: bookingEvents.weekdays,
			timeRanges: bookingEvents.timeRanges,
			startTime: bookingEvents.startTime,
			endTime: bookingEvents.endTime,
			timeZone: bookingEvents.timeZone,
		})
		.from(bookingEvents)
		.where(and(eq(bookingEvents.userId, userId), eq(bookingEvents.enabled, true)))
		.orderBy(asc(bookingEvents.createdAt))
		.limit(1);
	return workingHoursOf(row ?? null);
}
