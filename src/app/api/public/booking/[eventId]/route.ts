import { NextResponse } from "next/server";
import { availableBookingSlots } from "@/lib/booking/availability";
import { getEnv } from "@/lib/cloudflare";
import { createBookedCalendarEvents } from "@/lib/booking/create";
import { allowBookingAttempt } from "@/lib/booking/rate-limit";
import type { PublicBookingRouteContext } from "./types";
import { loadPublicBookingEvent, parseBookingSubmission } from "./utils";

export async function GET(request: Request, { params }: PublicBookingRouteContext) {
	const { eventId } = await params;
	const found = await loadPublicBookingEvent(eventId, new URL(request.url).searchParams.get("username"));
	if (!found) return NextResponse.json({ error: "Booking event not found" }, { status: 404 });
	const slots = await availableBookingSlots(getEnv(), found.event, 60);
	return NextResponse.json({ event: found.event, hostName: found.hostName, slots });
}

export async function POST(request: Request, { params }: PublicBookingRouteContext) {
	const { eventId } = await params;
	if (!(await allowBookingAttempt(getEnv(), request))) {
		return NextResponse.json({ error: "Too many booking attempts. Try again in a minute." }, { status: 429 });
	}
	const found = await loadPublicBookingEvent(eventId, new URL(request.url).searchParams.get("username"));
	if (!found) return NextResponse.json({ error: "Booking event not found" }, { status: 404 });
	const submission = parseBookingSubmission(await request.json().catch(() => null));
	if ("error" in submission) return NextResponse.json({ error: submission.error }, { status: 400 });
	const { name, email, startsAt, guestEmails, notes } = submission;
	const slots = await availableBookingSlots(getEnv(), found.event, 60);
	const slot = slots.find((item) => item.startsAt === startsAt);
	if (!slot) return NextResponse.json({ error: "That time is no longer available." }, { status: 409 });
	if (!(await createBookedCalendarEvents(getEnv(), found.event, name, email, slot.startsAt, slot.endsAt, guestEmails, notes))) return NextResponse.json({ error: "That time is no longer available." }, { status: 409 });
	return NextResponse.json({ booked: true, startsAt: slot.startsAt, endsAt: slot.endsAt });
}
