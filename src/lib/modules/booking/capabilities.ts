import type { ModuleCapabilities } from "../module-types";
import { describeCapability } from "../schema-utils";
import { bookingSchemas } from "./schemas";

const describe = (name: string, meta: Parameters<typeof describeCapability>[2]) =>
	describeCapability(bookingSchemas, name, meta);

export const bookingCapabilities: ModuleCapabilities = {
	moduleId: "booking",
	promptFragment: null,
	descriptors: [
		describe("workingHours", {
			surfaces: ["service"],
			description: "A user's booking working hours: weekdays, time ranges and time zone, or null when none are set.",
			scopes: ["booking.read"],
			effect: "read",
		}),
		describe("resolveRefs", {
			surfaces: ["resolve_refs"],
			description: "Resolve booking event type and appointment references to a link and a label.",
			scopes: ["booking.read"],
			effect: "read",
			refs: { kinds: ["booking:event_type", "booking:appointment"] },
		}),
		describe("userCreated", {
			surfaces: ["lifecycle"],
			description: "Give a new account its booking username.",
			effect: "update",
			lifecycle: { event: "user.created", dataHook: false },
		}),
		describe("appointmentCreated", {
			surfaces: ["webhook_event"],
			description: "Someone booked a time on a booking page.",
			effect: "none",
			event: { value: "booking.appointment.created" },
		}),
	],
};
