import { and, eq, isNull, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEvents } from "@/db/schema";

/**
 * Legacy recurring series have no recorded time zone. Freezes the zone they were read in, so a change
 * of the account preference does not move their future occurrences.
 */
export async function freezeLegacySeriesTimeZone(env: CloudflareEnv, userId: string, timeZone: string): Promise<void> {
	await getDb(env)
		.update(calendarEvents)
		.set({ timeZone })
		.where(and(eq(calendarEvents.userId, userId), isNull(calendarEvents.timeZone), ne(calendarEvents.repeat, "none")));
}
