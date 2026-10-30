import { z } from "zod";
import { calendarInviteSchema } from "@/lib/agent/auto-read/suggestion-utils";
import { REMINDER_KEY_PATTERN } from "@/lib/calendar/reminder-utils";
import { CALENDAR_TOOL_NAMES, calendarToolSchemas } from "@/lib/calendar/tool-schemas";
import { isValidTimeZone } from "@/lib/time/utils";
import type { ModuleSchemas } from "../schema-utils";
import {
	actionSchemas,
	approvalPreviewOutputSchema,
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

const reminderKey = z.string().regex(REMINDER_KEY_PATTERN, "Use <namespace>:<id> without @");
const userId = z.string().min(1);
const refused = z.object({ refused: z.literal("forbidden") });

const upsertReminder: ModuleSchemas[string] = {
	input: z.object({
		userId,
		key: reminderKey,
		title: z.string().trim().min(1).max(120),
		description: z.string().max(2000),
		date: z
			.string()
			.regex(/^\d{4}-\d{2}-\d{2}$/)
			.refine((day) => new Date(`${day}T00:00:00.000Z`).toISOString().startsWith(day), "Not a calendar date"),
		time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
		durationMinutes: z.number().int().min(5).max(120),
		timeZone: z.string().min(1).max(64).refine(isValidTimeZone, "Unknown time zone"),
		sourceMessageId: z.string().min(1).nullable(),
	}),
	output: z.union([
		z.object({
			eventId: z.string(),
			ref: z.object({ kind: z.literal("calendar:event"), id: z.string() }),
			created: z.boolean(),
		}),
		refused,
	]),
};

const removeReminder: ModuleSchemas[string] = {
	input: z.object({ userId, key: reminderKey }),
	output: z.union([z.object({ removed: z.boolean() }), refused]),
};

/** The approval card lines for a proposed `update_events` or `delete_events` call. */
const previewToolChange: ModuleSchemas[string] = {
	input: z.object({
		tool: z.enum(["update_events", "delete_events"]),
		input: z.record(z.string(), z.unknown()),
	}),
	output: approvalPreviewOutputSchema,
};

export const calendarSchemas: ModuleSchemas = {
	...Object.fromEntries(CALENDAR_TOOL_NAMES.map((name) => [name, { input: calendarToolSchemas[name] }])),
	search: searchSchemas,
	resolveRefs: resolveRefsSchemas(["calendar:event"]),
	invite: baseTriageStepSchemas,
	calendar_invite: { input: calendarInviteSchema },
	answerInvite,
	previewToolChange,
	createEvent: actionSchemas,
	deleteEvent: actionSchemas,
	sendRsvp: actionSchemas,
	upsertReminder,
	removeReminder,
	timeZoneChanged: lifecycleSchemas("user.time_zone_changed"),
	eventCreated: { input: eventPayload },
	eventUpdated: { input: eventPayload },
	eventDeleted: { input: eventPayload },
};
