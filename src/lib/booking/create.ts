import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { newId } from "@/lib/ids";
import { createLogger } from "@/lib/logger.mjs";
import { moduleHost } from "@/lib/modules/host";
// Binds the payload schemas `emitWebhook` validates against.
import "@/lib/modules/invoke";
import { buildCallContext } from "@/lib/modules/capability-utils";
import type { BookingEventRecord } from "./types";
import { BOOKING_APPOINTMENT_CREATED, bookingAppointmentPayload, type BookedAppointment } from "./webhook-event-utils";

const log = createLogger("booking");

/**
 * Links the new calendar events to the booked event type in the same batch as the events. A database that
 * has not applied the module migration has no table to link in, which must not fail the booking.
 */
async function appointmentLinks(env: CloudflareEnv, event: BookingEventRecord, eventIds: string[], nowSeconds: number) {
	const table = await env.DB.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
		.bind("booking_appointments")
		.first();
	if (!table) {
		log.warn("booking.appointments_table_missing", { eventTypeId: event.id });
		return null;
	}
	return env.DB.prepare(
		`INSERT INTO booking_appointments (calendar_event_id, booking_event_id, created_at)
		SELECT id, ?, ? FROM calendar_events WHERE id IN (${eventIds.map(() => "?").join(", ")})`,
	).bind(event.id, nowSeconds, ...eventIds);
}

/**
 * How many of the new events exist. A batch reports each statement's `meta.changes` differently on D1 and
 * in local workerd, so the insert's own count cannot tell a booking that won from one the conflict check refused.
 */
async function insertedCount(env: CloudflareEnv, eventIds: string[]): Promise<number> {
	const row = await env.DB.prepare(
		`SELECT COUNT(*) AS total FROM calendar_events WHERE id IN (${eventIds.map(() => "?").join(", ")})`,
	)
		.bind(...eventIds)
		.first<{ total: number }>();
	return row?.total ?? 0;
}

/** Tells the event type owner's webhooks about the booking; a failure is logged and never fails the booking. */
async function emitAppointmentCreated(env: CloudflareEnv, event: BookingEventRecord, booking: BookedAppointment) {
	try {
		const [owner] = await getDb(env)
			.select({ role: users.role, isPrimaryAdmin: users.isPrimaryAdmin })
			.from(users)
			.where(eq(users.id, event.userId))
			.limit(1);
		if (!owner) return;
		const ctx = buildCallContext({
			trigger: "api",
			viewer: { userId: event.userId, ...owner },
			timeZone: event.timeZone,
		});
		await moduleHost.emitWebhook(ctx, "booking", BOOKING_APPOINTMENT_CREATED, bookingAppointmentPayload(booking));
	} catch (error) {
		log.warn("booking.webhook_failed", { error });
	}
}

/** The ref of a booking names the event on the owner's calendar, which the owner's webhooks can resolve. */
function ownerEventFirst(hostIds: string[], eventIds: string[], ownerId: string): string[] {
	const own = hostIds.indexOf(ownerId);
	return own <= 0 ? eventIds : [eventIds[own], ...eventIds.filter((_, index) => index !== own)];
}

export async function createBookedCalendarEvents(
	env: CloudflareEnv,
	event: BookingEventRecord,
	guestName: string,
	guestEmail: string,
	startsAt: string,
	endsAt: string,
	guestEmails: string[] = [],
	notes = "",
): Promise<boolean> {
	const hostIds = event.hostIds;
	const eventIds = hostIds.map(() => newId("evt"));
	const startSeconds = Math.floor(new Date(startsAt).getTime() / 1000);
	const endSeconds = Math.floor(new Date(endsAt).getTime() / 1000);
	const nowSeconds = Math.floor(Date.now() / 1000);
	const selectedHosts = hostIds.map(() => "(?, ?)").join(", ");
	const hostPlaceholders = hostIds.map(() => "?").join(", ");
	const insert = env.DB.prepare(
		`WITH requested_hosts(host_id, event_id) AS (VALUES ${selectedHosts}),
		conflicts AS MATERIALIZED (SELECT COUNT(*) AS total FROM calendar_events WHERE user_id IN (${hostPlaceholders}) AND repeat = 'none' AND starts_at < ? AND ends_at > ?)
		INSERT INTO calendar_events (id, user_id, mailbox_id, title, description, location, attendees, color, repeat, repeat_days, excluded_occurrences, time_zone, starts_at, ends_at, created_at, updated_at)
		SELECT requested_hosts.event_id, requested_hosts.host_id, NULL, ?, ?, ?, ?, ?, 'none', '[]', '[]', ?, ?, ?, ?, ?
		FROM requested_hosts CROSS JOIN conflicts
		WHERE conflicts.total = 0`,
	).bind(
		...hostIds.flatMap((id, index) => [id, eventIds[index]]),
		...hostIds,
		endSeconds,
		startSeconds,
		`${event.name} with ${guestName}`,
		[`Booked by ${guestName} (${guestEmail})`, notes].filter(Boolean).join("\n\n"),
		event.location,
		JSON.stringify([guestEmail, ...guestEmails]),
		event.color,
		event.timeZone,
		startSeconds,
		endSeconds,
		nowSeconds,
		nowSeconds,
	);
	const links = await appointmentLinks(env, event, eventIds, nowSeconds);
	if (links) await env.DB.batch([insert, links]);
	else await insert.run();
	const booked = (await insertedCount(env, eventIds)) === hostIds.length;
	if (booked)
		await emitAppointmentCreated(env, event, {
			eventTypeId: event.id,
			eventIds: ownerEventFirst(hostIds, eventIds, event.userId),
			startsAt,
			endsAt,
			timeZone: event.timeZone,
			bookerName: guestName,
			bookerEmail: guestEmail,
		});
	return booked;
}
