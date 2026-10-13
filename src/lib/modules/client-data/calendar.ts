import type { ClientModuleData } from "../module-types";

/** The slice of the calendar manifest that client code reads, so client bundles never carry the rest of it. */
export const calendarClientData: ClientModuleData = {
	id: "calendar",
	name: "Calendar",
	suggestionKinds: ["calendar_invite"],
	keyScopes: {
		mcp: [
			{
				scope: "mcp:calendar-read",
				mailboxBound: false,
				label: "Read calendar",
				description: "List, search, and inspect events and free time.",
			},
			{
				scope: "mcp:calendar-write",
				mailboxBound: false,
				label: "Manage calendar",
				description: "Create, update, and delete events.",
			},
		],
		api: [
			{
				scope: "calendar:read",
				label: "Read calendar",
				description: "Read your calendar events through the API.",
			},
			{
				scope: "calendar:write",
				label: "Manage calendar",
				description: "Create, update, and delete your calendar events through the API.",
			},
		],
	},
	nav: [
		{
			id: "calendar.mailbox-selector",
			label: "Calendar",
			href: "/calendar",
			icon: "CalendarDays",
			placement: "mailbox-selector",
			order: 10,
		},
		{
			id: "calendar.module-tabs",
			label: "Calendar",
			href: "/calendar",
			icon: "CalendarDays",
			placement: "module-tabs",
			order: 20,
		},
	],
	commands: [
		{
			id: "calendar.open",
			moduleId: "calendar",
			label: "Open Calendar",
			description: "Go to your calendar",
			keywords: ["events", "schedule", "agenda"],
			group: "Navigation",
			target: { type: "route", href: "/calendar" },
			effect: "navigate",
		},
		{
			id: "calendar.go_to_date",
			moduleId: "calendar",
			label: "Go to a date in Calendar",
			description: "Open the calendar on a given day",
			keywords: ["day", "date"],
			group: "Navigation",
			params: {
				type: "object",
				properties: { date: { type: "string", description: "YYYY-MM-DD", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } },
				required: ["date"],
				additionalProperties: false,
			},
			target: { type: "route", href: "/calendar?date={date}" },
			effect: "navigate",
		},
		{
			id: "calendar.new_event",
			moduleId: "calendar",
			label: "New event",
			description: "Open the new event dialog",
			keywords: ["create", "add", "meeting"],
			group: "Actions",
			target: { type: "client", action: "open_dialog", handler: "newEvent" },
			effect: "fill",
		},
	],
};
