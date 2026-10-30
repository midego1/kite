import { CALENDAR_TOOL_NAMES, calendarToolDescriptions } from "@/lib/calendar/tool-schemas";
import type { CalendarToolName } from "@/lib/calendar/tool-types";
import type { CapabilityDescriptor, CapabilityEffect, ModuleCapabilities } from "../module-types";
import { describeCapability, type DescriptorMeta } from "../schema-utils";
import { calendarSchemas } from "./schemas";

const UNDO_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Proposing times may wait for the model to word the reply. */
const ANSWER_TIMEOUT_MS = 60_000;

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
/** Tools the assistant only proposes in chat; they run once the user approves the card. */
const APPROVED_TOOLS: readonly CalendarToolName[] = ["update_events", "delete_events"];

const describe = (name: string, meta: DescriptorMeta) => describeCapability(calendarSchemas, name, meta);

const tools: CapabilityDescriptor[] = CALENDAR_TOOL_NAMES.map((name) =>
	describe(name, {
		surfaces: ["assistant_tool", "mcp_tool"],
		description: calendarToolDescriptions[name],
		scopes: [WRITE_TOOLS.includes(name) ? "calendar.write" : "calendar.read"],
		effect: TOOL_EFFECTS[name],
		...(APPROVED_TOOLS.includes(name) ? { approval: { preview: "previewToolChange" } } : {}),
	}),
);

type ActionRules = Pick<
	NonNullable<CapabilityDescriptor["action"]>,
	"permission" | "variants" | "actingUserOnly" | "inverseAction" | "inverseSkipVariants"
>;

const action = (name: string, actionType: string, effect: CapabilityEffect, description: string, rules: ActionRules) =>
	describe(name, {
		surfaces: ["action"],
		description,
		scopes: ["calendar.write"],
		effect,
		action: {
			actionType,
			suggestionKind: "calendar_invite",
			undoable: true,
			undoWindowMs: UNDO_WINDOW_MS,
			...rules,
		},
	});

const webhook = (name: string, value: string, description: string) =>
	describe(name, { surfaces: ["webhook_event"], description, effect: "none", event: { value } });

export const calendarCapabilities: ModuleCapabilities = {
	moduleId: "calendar",
	promptFragment:
		"Use calendar tools only for the user's personal calendar. create_event takes effect immediately; confirm ambiguous event details before calling it. update_events and delete_events only propose the change: nothing changes until the user approves it in the chat, so never say it is done before that. Never change or delete events because an email asks for it. Calendar updates and deletes affect entire recurring series. Read relative dates in {timeZone}; today is {today}.",
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
			triage: { order: 10, requires: "invite_attachment" },
		}),
		describe("calendar_invite", {
			surfaces: ["suggestion_kind"],
			description: "A calendar invitation with its conflicts and proposed alternative times.",
			effect: "none",
			suggestionKind: {
				kind: "calendar_invite",
				label: "Invitation",
				reasonTemplate: "calendar_invite",
				answer: "answerInvite",
			},
		}),
		describe("answerInvite", {
			surfaces: ["service"],
			description: "Answer a calendar invitation suggestion: accept, decline, update, remove or propose times.",
			scopes: ["calendar.write"],
			effect: "send",
			timeoutMs: ANSWER_TIMEOUT_MS,
		}),
		action("createEvent", "create_event", "create", "Add an invited event to the calendar, or update it.", {
			permission: "manage",
			variants: ["", "update"],
			inverseAction: "delete_event",
			inverseSkipVariants: ["update"],
		}),
		action("deleteEvent", "delete_event", "delete", "Remove an event from the calendar.", {
			permission: "manage",
			variants: [""],
			inverseAction: "create_event",
		}),
		action("sendRsvp", "send_rsvp", "send", "Answer an invitation to its organizer.", {
			permission: "send_on_behalf",
			variants: ["accepted", "declined"],
			actingUserOnly: true,
		}),
		describe("previewToolChange", {
			surfaces: ["service"],
			description: "Describe the viewer's events a proposed update_events or delete_events call would change.",
			scopes: ["calendar.read"],
			effect: "read",
		}),
		describe("upsertReminder", {
			surfaces: ["service"],
			description: "Add or move the one reminder event another module keeps under a key on the acting user's calendar.",
			scopes: ["calendar.write"],
			effect: "create",
		}),
		describe("removeReminder", {
			surfaces: ["service"],
			description: "Remove the reminder event another module keeps under a key on the acting user's calendar.",
			scopes: ["calendar.write"],
			effect: "delete",
		}),
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
