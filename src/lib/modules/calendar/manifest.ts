import type { ModuleManifest } from "../module-types";
import { calendarClientData } from "../client-data/calendar";

export const calendarManifest: ModuleManifest = {
	id: "calendar",
	name: calendarClientData.name,
	description: "Personal calendar with recurring events, calendar chat tools and automatic reading of invitations.",
	runtime: "builtin",
	dependsOn: [],
	defaultEnabled: true,
	pages: [{ prefix: "/calendar" }],
	apiPrefixes: [{ prefix: "/api/calendar" }],
	nav: calendarClientData.nav,
	commands: calendarClientData.commands,
	composerSlots: [],
	recordKinds: [{ kind: "calendar:event", label: "Calendar event", unavailableLabel: "Calendar event" }],
	webhookEvents: [
		{ value: "calendar.event.created", label: "Calendar event created", hint: "An event was added to a calendar" },
		{ value: "calendar.event.updated", label: "Calendar event updated", hint: "An event on a calendar was changed" },
		{ value: "calendar.event.deleted", label: "Calendar event deleted", hint: "An event was removed from a calendar" },
	],
	grants: [
		{ grant: "calendar.read", label: "Read calendar events" },
		{ grant: "calendar.write", label: "Create, change and delete calendar events" },
	],
	mcpScopes: [
		{ scope: "mcp:calendar-read", label: "Read calendar", grants: ["calendar.read"], mailboxBound: false },
		{
			scope: "mcp:calendar-write",
			label: "Read and change calendar",
			grants: ["calendar.read", "calendar.write"],
			mailboxBound: false,
		},
	],
	apiKeyScopes: [
		{ scope: "calendar:read", label: "Read calendar events", grants: ["calendar.read"] },
		{ scope: "calendar:write", label: "Change calendar events", grants: ["calendar.read", "calendar.write"] },
	],
	jmapCapabilities: [],
	searchSections: [{ id: "events", label: "Events" }],
	messageStatuses: [],
	queueMessageTypes: [],
	cronTasks: [],
	actionLabels: {
		create_event: "Added an event to the calendar",
		"create_event:update": "Updated a calendar event",
		update_event: "Updated a calendar event",
		delete_event: "Removed an event from the calendar",
		send_rsvp: "Answered an invitation",
		"send_rsvp:accepted": "Accepted an invitation",
		"send_rsvp:declined": "Declined an invitation",
	},
	reasonTexts: {
		calendar_invite: "The message includes a calendar invitation",
		"module_disabled:calendar": "Calendar is turned off",
	},
};
