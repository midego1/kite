import type { calendarEvents } from "@/db/schema";
import type { AcceptRefusal } from "./suggestion-api-utils";
import type { CalendarInvitePayload, SuggestionStatus } from "./suggestion-types";

const INVITE_OPTIONS = [
	"accept",
	"decline",
	"propose",
	"update",
	"remove",
	"decline_instead",
	"accept_instead",
] as const;

export type InviteOption = (typeof INVITE_OPTIONS)[number];
export type Partstat = "accepted" | "declined";
/** The reply currently standing for the invitation: the one live `send_rsvp` row. */
export type RsvpState = Partstat | null;

const NEEDS_SEND: readonly InviteOption[] = ["accept", "decline", "propose", "decline_instead", "accept_instead"];
const NEEDS_ORGANIZER: readonly InviteOption[] = ["accept", "decline", "propose", "decline_instead", "accept_instead"];
const INSTEAD: readonly InviteOption[] = ["decline_instead", "accept_instead"];

export const FALLBACK_PROPOSAL_INTRO =
	"Thank you for the invitation. That time does not work for me. Could one of these times work instead?";

export const PROPOSAL_INSTRUCTIONS =
	"The sender invited the owner to a meeting at a time that does not work. Write two or three short sentences that thank them, say the proposed time does not work, and ask whether one of the alternative times listed after your message would suit. Do not mention any date or time yourself.";

const CLOCK_TIME = /\b\d{1,2}[:.]\d{2}\b|\b\d{1,2}\s?(?:am|pm)\b/i;

/** Whether generated text names a clock time; the times in a proposal must come from code, never the model. */
export function namesATime(text: string): boolean {
	return CLOCK_TIME.test(text);
}

function isInviteOption(value: string): value is InviteOption {
	return (INVITE_OPTIONS as readonly string[]).includes(value);
}

/** Which options an invitation's shape allows: an update, a cancellation, or a new request. */
function optionsFor(payload: CalendarInvitePayload): readonly InviteOption[] {
	if (payload.method === "CANCEL") return ["remove"];
	if (payload.existingEventId) return ["update"];
	return ["accept", "decline", "propose", "decline_instead", "accept_instead"];
}

type RefusalInput = {
	option: string;
	status: SuggestionStatus;
	payload: CalendarInvitePayload;
	rsvp: RsvpState;
	canSend: boolean;
};

/**
 * Why a calendar option cannot run now, or null. `*_instead` follow an earlier decision and compare
 * against the reply that currently stands, so a repeated click is refused instead of sending twice.
 */
export function inviteOptionRefusal(input: RefusalInput): AcceptRefusal | null {
	const { option, status, payload } = input;
	if (!isInviteOption(option)) return { status: 400, error: "Unknown option for this suggestion" };
	if (!optionsFor(payload).includes(option))
		return { status: 400, error: "This option does not apply to this invitation" };
	if (NEEDS_SEND.includes(option) && !input.canSend)
		return { status: 403, error: "You need permission to send from this mailbox" };
	if (NEEDS_ORGANIZER.includes(option) && !payload.organizer)
		return { status: 409, error: "The invitation names no organizer to reply to" };
	if (INSTEAD.includes(option)) {
		if (status !== "accepted") return { status: 409, error: "Answer the invitation first" };
		const standing: Partstat = option === "decline_instead" ? "declined" : "accepted";
		return input.rsvp === standing ? { status: 409, error: "That reply was already sent" } : null;
	}
	return status === "open" ? null : { status: 409, error: "This suggestion is no longer open" };
}

export function rsvpSubject(partstat: Partstat, summary: string): string {
	const name = summary.replace(/\s+/g, " ").trim() || "Invitation";
	return `${partstat === "accepted" ? "Accepted" : "Declined"}: ${name}`.slice(0, 200);
}

export function rsvpText(partstat: Partstat, summary: string): string {
	const name = summary.replace(/\s+/g, " ").trim() || "your invitation";
	return `${partstat === "accepted" ? "I will attend" : "I cannot attend"}: ${name}`;
}

function zonedParts(date: Date, timeZone: string, options: Intl.DateTimeFormatOptions): string {
	return new Intl.DateTimeFormat("en-GB", { timeZone, ...options }).format(date);
}

/** One line per slot, e.g. `Tue 13 Oct 2026, 13:00-14:00 (Europe/Amsterdam)`. */
export function formatProposalSlots(slots: readonly { start: string; end: string }[], timeZone: string): string[] {
	return slots.map(({ start, end }) => {
		const from = new Date(start);
		const day = zonedParts(from, timeZone, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
		const clock: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
		return `${day}, ${zonedParts(from, timeZone, clock)}-${zonedParts(new Date(end), timeZone, clock)} (${timeZone})`;
	});
}

/** The model writes only the intro; the times are appended by code so the model never picks them. */
export function proposalBody(intro: string, slots: readonly { start: string; end: string }[], timeZone: string) {
	const lines = formatProposalSlots(slots, timeZone).map((slot) => `- ${slot}`);
	return `${intro.trim() || FALLBACK_PROPOSAL_INTRO}\n\n${lines.join("\n")}`;
}

type EventInsert = typeof calendarEvents.$inferInsert;

/** The reviewer's calendar row for an accepted invitation; `mailboxId` stays empty so edits never email attendees. */
export function inviteEventValues(
	payload: CalendarInvitePayload,
	input: { id: string; userId: string; messageId: string; now: Date },
): EventInsert {
	return {
		id: input.id,
		userId: input.userId,
		mailboxId: null,
		title: payload.summary.trim() || "Untitled event",
		location: payload.location ?? "",
		timeZone: payload.tz,
		startsAt: new Date(payload.start),
		endsAt: new Date(payload.end),
		icalUid: payload.uid,
		icalSequence: payload.sequence,
		organizer: payload.organizer,
		sourceMessageId: input.messageId,
		status: "confirmed",
		createdAt: input.now,
		updatedAt: input.now,
	};
}

export type EventSnapshot = {
	title: string;
	location: string;
	timeZone: string | null;
	startsAt: number;
	endsAt: number;
	icalSequence: number | null;
	organizer: string | null;
};

/** The fields an update overwrites, as JSON-safe numbers, so undo can put them back. */
export function snapshotEvent(row: typeof calendarEvents.$inferSelect): EventSnapshot {
	return {
		title: row.title,
		location: row.location,
		timeZone: row.timeZone,
		startsAt: row.startsAt.getTime(),
		endsAt: row.endsAt.getTime(),
		icalSequence: row.icalSequence,
		organizer: row.organizer,
	};
}

export function snapshotValues(snapshot: EventSnapshot) {
	return {
		title: snapshot.title,
		location: snapshot.location,
		timeZone: snapshot.timeZone,
		startsAt: new Date(snapshot.startsAt),
		endsAt: new Date(snapshot.endsAt),
		icalSequence: snapshot.icalSequence,
		organizer: snapshot.organizer,
	};
}

type EventRow = typeof calendarEvents.$inferSelect;
const DATE_FIELDS = ["startsAt", "endsAt", "createdAt", "updatedAt", "repeatUntil"] as const;

/** A whole event row as JSON, with dates as milliseconds, so a removal can be undone exactly. */
export function serializeEventRow(row: EventRow): Record<string, unknown> {
	const copy: Record<string, unknown> = { ...row };
	for (const field of DATE_FIELDS) copy[field] = row[field] instanceof Date ? row[field].getTime() : null;
	return copy;
}

/** The event row serializeEventRow stored, or null when the value is not one. */
export function deserializeEventRow(value: Record<string, unknown> | null): EventRow | null {
	if (!value || typeof value.id !== "string" || typeof value.userId !== "string") return null;
	const row: Record<string, unknown> = { ...value };
	for (const field of DATE_FIELDS) row[field] = typeof value[field] === "number" ? new Date(value[field]) : null;
	return row as EventRow;
}
