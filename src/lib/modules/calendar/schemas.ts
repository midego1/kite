import { z } from "zod";
import { calendarInviteSchema } from "@/lib/agent/auto-read/suggestion-utils";
import { CALENDAR_TOOL_NAMES, calendarToolSchemas } from "@/lib/calendar/tool-schemas";
import type { ModuleSchemas } from "../schema-utils";
import {
	actionSchemas,
	instantSchema,
	lifecycleSchemas,
	resolveRefsSchemas,
	searchSchemas,
	triageStepSchemas,
} from "../shared-schemas";

const eventPayload = z.object({
	ref: z.object({ kind: z.literal("calendar:event"), id: z.string() }),
	event: z.object({
		id: z.string(),
		title: z.string(),
		start: instantSchema,
		end: instantSchema,
		timeZone: z.string(),
	}),
});

export const calendarSchemas: ModuleSchemas = {
	...Object.fromEntries(CALENDAR_TOOL_NAMES.map((name) => [name, { input: calendarToolSchemas[name] }])),
	search: searchSchemas,
	resolveRefs: resolveRefsSchemas(["calendar:event"]),
	invite: triageStepSchemas,
	calendar_invite: { input: calendarInviteSchema },
	createEvent: actionSchemas,
	deleteEvent: actionSchemas,
	sendRsvp: actionSchemas,
	timeZoneChanged: lifecycleSchemas("user.time_zone_changed"),
	eventCreated: { input: eventPayload },
	eventUpdated: { input: eventPayload },
	eventDeleted: { input: eventPayload },
};
