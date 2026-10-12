import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { CALENDAR_TOOL_NAMES } from "@/lib/calendar/tool-schemas";
import type { CalendarToolName } from "@/lib/calendar/tool-types";
import { runCalendarTool } from "@/lib/calendar/tools";
import { getEnv } from "@/lib/cloudflare";
import { pendingHandler, unavailableRefsHandler } from "../handler-helpers";
import type { CapabilityHandler, JsonValue } from "../module-types";

function toolHandler(name: CalendarToolName): CapabilityHandler {
	return async (input, ctx) => {
		if (!ctx.viewer) throw new Error("Calendar tools need a viewer");
		const env = getEnv();
		const [user] = await getDb(env).select().from(users).where(eq(users.id, ctx.viewer.userId)).limit(1);
		if (!user) throw new Error("Viewer not found");
		return (await runCalendarTool({ env, user, timeZone: ctx.timeZone }, name, input)) as JsonValue;
	};
}

export const calendarHandlers: Record<string, CapabilityHandler> = {
	...Object.fromEntries(CALENDAR_TOOL_NAMES.map((name) => [name, toolHandler(name)])),
	search: async () => ({ items: [] }),
	resolveRefs: unavailableRefsHandler,
	invite: pendingHandler("The calendar invite step"),
	createEvent: pendingHandler("The create event action"),
	deleteEvent: pendingHandler("The delete event action"),
	sendRsvp: pendingHandler("The RSVP action"),
	timeZoneChanged: async () => ({ handled: false }),
};
