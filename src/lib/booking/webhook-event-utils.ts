import type { JsonValue } from "@/lib/modules/module-types";

export const BOOKING_APPOINTMENT_CREATED = "booking.appointment.created";

export type BookedAppointment = {
	eventTypeId: string;
	/** The calendar event each host got, first host first. */
	eventIds: string[];
	startsAt: string;
	endsAt: string;
	timeZone: string;
	bookerName: string;
	bookerEmail: string;
};

/**
 * The ref plus the minimal record of one booking (spec §11.5). The ref names the first host's calendar
 * event, which is what a `booking:appointment` ref points at.
 */
export function bookingAppointmentPayload(booking: BookedAppointment): JsonValue {
	return {
		ref: { kind: "booking:appointment", id: booking.eventIds[0] },
		appointment: {
			eventTypeId: booking.eventTypeId,
			eventIds: booking.eventIds,
			start: new Date(booking.startsAt).toISOString(),
			end: new Date(booking.endsAt).toISOString(),
			timeZone: booking.timeZone,
			bookerName: booking.bookerName,
			bookerEmail: booking.bookerEmail,
		},
	};
}
