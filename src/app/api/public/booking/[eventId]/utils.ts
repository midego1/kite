import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { bookingEvents, users } from "@/db/schema";
import { parseBookingTimeRanges, parseBookingWeekdays } from "@/lib/booking/utils";
import type { BookingEventRecord } from "@/lib/booking/types";
import { getEnv } from "@/lib/cloudflare";
import { parseBookingHostIds } from "@/lib/booking/hosts";
import type { PublicBookingSubmission, ValidBookingSubmission } from "./types";

function parseBookingGuestEmails(value: unknown, bookerEmail: string): string[] | null {
	if (value === undefined || value === "") return [];
	if (typeof value !== "string" || value.length > 2000) return null;
	const emails = value.split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
	if (emails.length > 20 || emails.some((email) => email.length > 254 || !/^\S+@\S+\.\S+$/.test(email))) return null;
	return [...new Set(emails.filter((email) => email !== bookerEmail))];
}

export function parseBookingSubmission(
	value: unknown,
): ValidBookingSubmission | { error: string } {
	const body = (value && typeof value === "object" ? value : {}) as PublicBookingSubmission;
	const name = typeof body.name === "string" ? body.name.trim() : "";
	const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
	const validContact = name && name.length <= 120 && /^\S+@\S+\.\S+$/.test(email) && email.length <= 254;
	if (!validContact || typeof body.startsAt !== "string") return { error: "Enter your name, email, and a time." };
	const guestEmails = parseBookingGuestEmails(body.guestEmails, email);
	const notes = typeof body.notes === "string" ? body.notes.trim() : "";
	if (!guestEmails || notes.length > 2000 || (body.notes !== undefined && typeof body.notes !== "string"))
		return { error: "Check the guest emails and meeting notes." };
	return { name, email, startsAt: body.startsAt, guestEmails, notes };
}

export async function loadPublicBookingEvent(eventId: string, username?: string | null) {
	const db = getDb(getEnv());
	const [matchedUser] = username ? await db.select({ id: users.id }).from(users).where(and(eq(users.bookingUsername, username.toLowerCase()), eq(users.disabled, false))).limit(1) : [];
	if (username && !matchedUser) return null;
	const [event] = await db.select().from(bookingEvents).where(and(username ? eq(bookingEvents.slug, eventId) : eq(bookingEvents.id, eventId), username ? eq(bookingEvents.userId, matchedUser!.id) : undefined, eq(bookingEvents.enabled, true))).limit(1);
	if (!event) return null;
	const hostIds = parseBookingHostIds(event.hostIds, event.userId);
	const hosts = await db.select({ id: users.id, name: users.name }).from(users).where(and(inArray(users.id, hostIds), eq(users.disabled, false)));
	if (hosts.length !== hostIds.length) return null;
	return { event: { ...event, hostIds, weekdays: parseBookingWeekdays(event.weekdays), timeRanges: parseBookingTimeRanges(event.timeRanges, { startTime: event.startTime, endTime: event.endTime }) } as BookingEventRecord, hostName: hostIds.map((id) => hosts.find((host) => host.id === id)?.name).join(", ") };
}
