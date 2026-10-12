import type { ClientModuleData } from "../module-types";

/** The slice of the booking manifest that client code reads, so client bundles never carry the rest of it. */
export const bookingClientData: ClientModuleData = {
	id: "booking",
	name: "Booking",
	nav: [
		{
			id: "booking.module-tabs",
			label: "Bookings",
			href: "/booking",
			icon: "CalendarClock",
			placement: "module-tabs",
			order: 10,
		},
		{
			id: "booking.account-menu",
			label: "Booking",
			href: "/booking",
			icon: "CalendarClock",
			placement: "account-menu",
			order: 20,
		},
	],
	commands: [
		{
			id: "booking.open",
			moduleId: "booking",
			label: "Open Booking",
			description: "Go to your booking pages",
			keywords: ["appointments", "schedule", "meeting"],
			group: "Navigation",
			target: { type: "route", href: "/booking" },
			effect: "navigate",
		},
		{
			id: "booking.open_event_type",
			moduleId: "booking",
			label: "Open a booking event type",
			description: "Open one booking event type",
			keywords: ["event type"],
			group: "Navigation",
			params: {
				type: "object",
				properties: { id: { type: "string", description: "Booking event type id", minLength: 1, maxLength: 160 } },
				required: ["id"],
				additionalProperties: false,
			},
			target: { type: "route", href: "/booking?event={id}" },
			effect: "navigate",
		},
		{
			id: "booking.copy_link",
			moduleId: "booking",
			label: "Copy booking link",
			description: "Copy the public link to your booking page",
			keywords: ["share", "url"],
			group: "Actions",
			target: { type: "client", action: "invoke", handler: "copyLink" },
			effect: "read",
		},
	],
};
