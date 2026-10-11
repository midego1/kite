import { findConflicts, type WorkHours } from "@/lib/calendar/availability-utils";
import type { IcsInvite } from "@/lib/calendar/ics-parse-utils";
import { normalizeEmailAddress } from "@/lib/email/address";
import { dateFromZonedFields, normalizeTimeZone } from "@/lib/time/utils";
import type { CalendarInvitePayload } from "./suggestion-types";

const INVITE_MARGIN_MS = 30 * 60_000;
const MAX_WINDOW_MS = 90 * 86_400_000;
const MAX_CONFLICTS = 20;
const PROPOSAL_COUNT = 3;
const DISPLAY_TEXT_MAX = 500;

/** The payload schema counts code points, so cut on them rather than UTF-16 units. */
function truncateCodePoints(value: string, max: number): string {
	const points = Array.from(value);
	return points.length > max ? points.slice(0, max).join("") : value;
}

export type BookingHoursRow = {
	weekdays: string;
	timeRanges: string;
	startTime: string;
	endTime: string;
	timeZone: string;
};

export type StoredInviteEvent = { id: string; icalSequence: number | null };

export type ScheduleEvent = { id: string; seriesId: string; title: string; startsAt: string; endsAt: string };

export type InviteVariant = { method: "REQUEST" | "CANCEL"; existingEventId: string | null } | null;

function parseJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

const CLOCK = /^\d{1,2}:\d{2}$/;

function parseRanges(value: string, fallback: WorkHours["ranges"]): WorkHours["ranges"] {
	const parsed = parseJson(value);
	if (!Array.isArray(parsed)) return fallback;
	const ranges = parsed.flatMap((range) => {
		const { startTime, endTime } = (range ?? {}) as { startTime?: unknown; endTime?: unknown };
		return typeof startTime === "string" && typeof endTime === "string" && CLOCK.test(startTime) && CLOCK.test(endTime)
			? [{ startTime, endTime }]
			: [];
	});
	return ranges.length ? ranges : fallback;
}

/** Working hours from the reviewer's first enabled booking event, else Monday to Friday 09:00-17:00 in their zone. */
export function resolveWorkingHours(
	booking: BookingHoursRow | null,
	userTimeZone: string | null,
): { workHours: WorkHours; tz: string } {
	if (!booking)
		return {
			workHours: { weekdays: [1, 2, 3, 4, 5], ranges: [{ startTime: "09:00", endTime: "17:00" }] },
			tz: normalizeTimeZone(userTimeZone),
		};
	const parsedDays = parseJson(booking.weekdays);
	const weekdays = Array.isArray(parsedDays)
		? parsedDays.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6)
		: [1, 2, 3, 4, 5];
	return {
		workHours: {
			weekdays,
			ranges: parseRanges(booking.timeRanges, [{ startTime: booking.startTime, endTime: booking.endTime }]),
		},
		tz: normalizeTimeZone(booking.timeZone),
	};
}

/**
 * What an invite means next to the reviewer's stored event with the same UID: a new event, an update
 * (higher SEQUENCE only), a removal, or nothing (already known, an older SEQUENCE, or nothing to remove).
 */
export function inviteVariant(invite: IcsInvite, stored: StoredInviteEvent | null): InviteVariant {
	if (invite.method === "CANCEL") return stored ? { method: "CANCEL", existingEventId: stored.id } : null;
	if (invite.method !== null && invite.method !== "REQUEST" && invite.method !== "PUBLISH") return null;
	if (!stored) return { method: "REQUEST", existingEventId: null };
	return invite.sequence > (stored.icalSequence ?? 0) ? { method: "REQUEST", existingEventId: stored.id } : null;
}

/**
 * An all-day invite is a calendar date, not an instant: the parser anchors it at midnight UTC, so it
 * is moved to midnight in the reviewer's zone, which keeps the event on that date in their calendar.
 */
export function localizeAllDay<T extends Pick<IcsInvite, "start" | "end" | "tz"> & { allDay?: boolean }>(
	invite: T,
	userTimeZone: string | null,
): T {
	if (!invite.allDay) return invite;
	const tz = normalizeTimeZone(userTimeZone);
	return {
		...invite,
		tz,
		start: dateFromZonedFields(new Date(invite.start), tz).toISOString(),
		end: dateFromZonedFields(new Date(invite.end), tz).toISOString(),
	};
}

/** The range `get_schedule` is asked for: the event plus 30 minutes either side, capped at its 90-day limit. */
export function availabilityWindow(invite: IcsInvite): { from: Date; to: Date } {
	const from = new Date(Date.parse(invite.start) - INVITE_MARGIN_MS);
	const to = new Date(Math.min(Date.parse(invite.end) + INVITE_MARGIN_MS, from.getTime() + MAX_WINDOW_MS));
	return { from, to };
}

/** Events that overlap the invite itself, ignoring the stored copy of the invite being updated. */
export function overlappingEvents(events: ScheduleEvent[], invite: IcsInvite, existingEventId: string | null) {
	const others = events.filter((event) => event.seriesId !== existingEventId && event.id !== existingEventId);
	return findConflicts(others, new Date(invite.start), new Date(invite.end));
}

export function buildInvitePayload(input: {
	invite: IcsInvite;
	variant: NonNullable<InviteVariant>;
	senderAddress: string;
	authPassed: boolean;
	conflicts: ScheduleEvent[];
	proposals: Array<{ start: string; end: string }>;
}): CalendarInvitePayload {
	const { invite, variant } = input;
	const cancel = variant.method === "CANCEL";
	const organizer = invite.organizer?.email ?? null;
	return {
		uid: invite.uid,
		sequence: invite.sequence,
		method: variant.method,
		organizer,
		start: invite.start,
		end: invite.end,
		tz: invite.tz,
		summary: truncateCodePoints(invite.summary, DISPLAY_TEXT_MAX),
		location: truncateCodePoints(invite.location, DISPLAY_TEXT_MAX) || null,
		repeats: !!invite.rrule,
		allDay: invite.allDay,
		conflicts: cancel
			? []
			: input.conflicts
					.slice(0, MAX_CONFLICTS)
					.map((event) => ({ eventId: event.id, title: event.title, start: event.startsAt, end: event.endsAt })),
		proposals: cancel ? [] : input.proposals.slice(0, PROPOSAL_COUNT),
		organizerMatchesSender:
			!!organizer && normalizeEmailAddress(organizer) === normalizeEmailAddress(input.senderAddress),
		authPassed: input.authPassed,
		existingEventId: variant.existingEventId,
	};
}
