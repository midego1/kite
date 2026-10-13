import type { ModuleManifest } from "../module-types";
import { bookingClientData } from "../client-data/booking";

export const bookingManifest: ModuleManifest = {
	id: "booking",
	name: bookingClientData.name,
	description: "Public booking pages where people pick a free time on your calendar. Needs Calendar.",
	runtime: "builtin",
	dependsOn: ["calendar"],
	defaultEnabled: true,
	pages: [{ prefix: "/booking" }, { prefix: "/book", public: true }, { prefix: "/c", public: true }],
	apiPrefixes: [{ prefix: "/api/booking" }, { prefix: "/api/public/booking", public: true }],
	nav: bookingClientData.nav,
	commands: bookingClientData.commands,
	composerSlots: [],
	recordKinds: [
		{ kind: "booking:event_type", label: "Booking event type", unavailableLabel: "Booking" },
		{ kind: "booking:appointment", label: "Booked appointment", unavailableLabel: "Booking" },
	],
	webhookEvents: [
		{
			value: "booking.appointment.created",
			label: "Appointment booked",
			hint: "Someone booked a time on a booking page",
		},
	],
	grants: [
		{ grant: "booking.read", label: "Read booking pages and working hours" },
		{ grant: "booking.write", label: "Change booking pages" },
	],
	mcpScopes: [],
	apiKeyScopes: [],
	jmapCapabilities: [],
	searchSections: [],
	messageStatuses: [],
	queueMessageTypes: [],
	cronTasks: [],
	actionLabels: {},
	reasonTexts: { "module_disabled:booking": "Booking is turned off" },
	adminNotes: ["Turning Calendar off also turns Booking off. Booking comes back when Calendar does."],
};
