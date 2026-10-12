import { CALENDAR_TOOL_NAMES, calendarToolDescriptions } from "@/lib/calendar/tool-schemas";
import type { CalendarToolName } from "@/lib/calendar/tool-types";
import type { CapabilityDescriptor, CapabilityEffect, ModuleCapabilities } from "../module-types";
import { describeCapability, type DescriptorMeta } from "../schema-utils";
import { calendarSchemas } from "./schemas";

const UNDO_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const TOOL_EFFECTS: Record<CalendarToolName, CapabilityEffect> = {
	get_schedule: "read",
	search_events: "read",
	get_event: "read",
	create_event: "create",
	update_events: "update",
	delete_events: "delete",
	find_free_time: "read",
	get_calendars: "read",
};

const WRITE_TOOLS: readonly CalendarToolName[] = ["create_event", "update_events", "delete_events"];

const describe = (name: string, meta: DescriptorMeta) => describeCapability(calendarSchemas, name, meta);

const tools: CapabilityDescriptor[] = CALENDAR_TOOL_NAMES.map((name) =>
	describe(name, {
		surfaces: ["assistant_tool", "mcp_tool"],
		description: calendarToolDescriptions[name],
		scopes: [WRITE_TOOLS.includes(name) ? "calendar.write" : "calendar.read"],
		effect: TOOL_EFFECTS[name],
	}),
);

const action = (name: string, actionType: string, effect: CapabilityEffect, description: string) =>
	describe(name, {
		surfaces: ["action"],
		description,
		scopes: ["calendar.write"],
		effect,
		action: { actionType, suggestionKind: "calendar_invite", undoable: true, undoWindowMs: UNDO_WINDOW_MS },
	});

const webhook = (name: string, value: string, description: string) =>
	describe(name, { surfaces: ["webhook_event"], description, effect: "none", event: { value } });

export const calendarCapabilities: ModuleCapabilities = {
	moduleId: "calendar",
	promptFragment:
		"Use calendar tools only for the user's personal calendar. Calendar writes take effect immediately; confirm ambiguous event details before calling them. Calendar updates and deletes affect entire recurring series. Read relative dates in {timeZone}; today is {today}.",
	descriptors: [
		...tools,
		describe("search", {
			surfaces: ["search"],
			description: "Search the viewer's calendar events by title, description, location and attendees.",
			scopes: ["calendar.read"],
			effect: "read",
			search: { section: "events" },
		}),
		describe("resolveRefs", {
			surfaces: ["resolve_refs"],
			description: "Resolve calendar event references to a link and a label.",
			scopes: ["calendar.read"],
			effect: "read",
			refs: { kinds: ["calendar:event"] },
		}),
		describe("invite", {
			surfaces: ["triage_step"],
			description: "Read a calendar invitation attached to a message and propose how to answer it.",
			scopes: ["calendar.read"],
			effect: "read",
			triage: { order: 10 },
		}),
		describe("calendar_invite", {
			surfaces: ["suggestion_kind"],
			description: "A calendar invitation with its conflicts and proposed alternative times.",
			effect: "none",
			suggestionKind: { kind: "calendar_invite", label: "Invitation", reasonTemplate: "calendar_invite" },
		}),
		action("createEvent", "create_event", "create", "Add an invited event to the calendar, or update it."),
		action("deleteEvent", "delete_event", "delete", "Remove an event from the calendar."),
		action("sendRsvp", "send_rsvp", "send", "Answer an invitation to its organizer."),
		describe("timeZoneChanged", {
			surfaces: ["lifecycle"],
			description: "Freeze legacy recurring series when a user changes time zone.",
			effect: "update",
			lifecycle: { event: "user.time_zone_changed", dataHook: true },
		}),
		webhook("eventCreated", "calendar.event.created", "An event was added to a calendar."),
		webhook("eventUpdated", "calendar.event.updated", "An event on a calendar was changed."),
		webhook("eventDeleted", "calendar.event.deleted", "An event was removed from a calendar."),
	],
};
