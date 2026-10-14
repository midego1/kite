import { z } from "zod";
import { calendarInviteSchema } from "@/lib/agent/auto-read/suggestion-utils";
import { CALENDAR_TOOL_NAMES, calendarToolSchemas } from "@/lib/calendar/tool-schemas";
import type { ModuleSchemas } from "../schema-utils";
import {
	actionSchemas,
	baseTriageStepSchemas,
	instantSchema,
	lifecycleSchemas,
	resolveRefsSchemas,
	searchSchemas,
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

const answerInvite: ModuleSchemas[string] = {
	input: z.object({
		suggestionId: z.string().min(1),
		option: z.string().max(40),
		deviceTimeZone: z.string().nullable(),
	}),
	output: z.object({
		result: z.record(z.string(), z.unknown()).nullable().optional(),
		refused: z.object({ status: z.number().int(), error: z.string() }).optional(),
	}),
};

export const calendarSchemas: ModuleSchemas = {
	...Object.fromEntries(CALENDAR_TOOL_NAMES.map((name) => [name, { input: calendarToolSchemas[name] }])),
	search: searchSchemas,
	resolveRefs: resolveRefsSchemas(["calendar:event"]),
	invite: baseTriageStepSchemas,
	calendar_invite: { input: calendarInviteSchema },
	answerInvite,
	createEvent: actionSchemas,
	deleteEvent: actionSchemas,
	sendRsvp: actionSchemas,
	timeZoneChanged: lifecycleSchemas("user.time_zone_changed"),
	eventCreated: { input: eventPayload },
	eventUpdated: { input: eventPayload },
	eventDeleted: { input: eventPayload },
};
