import type { InviteOption } from "@/lib/agent/auto-read/invite-actions-utils";
import type { CalendarInvitePayload } from "@/lib/agent/auto-read/suggestion-types";
import type { ActivityAction } from "./agent-activity-types";
import type { CardSuggestion } from "./suggestion-card-types";

type Conflict = CalendarInvitePayload["conflicts"][number];

function isTime(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isConflict(value: unknown): value is Conflict {
	const item = value as Partial<Conflict> | null;
	return !!item && typeof item.title === "string" && isTime(item.start) && isTime(item.end);
}

/** The invitation behind a calendar suggestion, or null when the stored payload is not usable. */
export function invitePayload(suggestion: Pick<CardSuggestion, "payload">): CalendarInvitePayload | null {
	const raw = suggestion.payload as Partial<CalendarInvitePayload>;
	if (typeof raw.uid !== "string" || !isTime(raw.start) || !isTime(raw.end)) return null;
	return {
		...(raw as CalendarInvitePayload),
		summary: typeof raw.summary === "string" ? raw.summary : "",
		conflicts: Array.isArray(raw.conflicts) ? raw.conflicts.filter(isConflict) : [],
		proposals: Array.isArray(raw.proposals) ? raw.proposals : [],
	};
}

function part(date: Date, timeZone: string, options: Intl.DateTimeFormatOptions): string {
	return new Intl.DateTimeFormat(undefined, { timeZone, ...options }).format(date);
}

const DAY: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short", year: "numeric" };
const CLOCK: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };

/** `Tue, 13 Oct 2026, 10:00 – 10:30` in the viewer's time zone; both days when the event spans midnight. */
export function formatInviteRange(start: string, end: string, timeZone: string): string {
	const from = new Date(start);
	const to = new Date(end);
	const day = part(from, timeZone, DAY);
	const sameDay = day === part(to, timeZone, DAY);
	const finish = sameDay ? part(to, timeZone, CLOCK) : `${part(to, timeZone, DAY)}, ${part(to, timeZone, CLOCK)}`;
	return `${day}, ${part(from, timeZone, CLOCK)} – ${finish}`;
}

/** The invite's time line; an all-day invite shows its dates in the zone its midnights were set in, never shifted. */
export function formatInviteWhen(payload: CalendarInvitePayload, viewerTimeZone: string): string {
	if (!payload.allDay) return formatInviteRange(payload.start, payload.end, viewerTimeZone);
	const zone = payload.tz ?? viewerTimeZone;
	const first = part(new Date(payload.start), zone, DAY);
	const last = part(new Date(Date.parse(payload.end) - 1), zone, DAY);
	return `${first === last || Date.parse(payload.end) <= Date.parse(payload.start) ? first : `${first} – ${last}`} · All day`;
}

export type InviteButton = { option: InviteOption; label: string; primary?: boolean };

/** The answers an open invitation offers; an update or a cancellation replaces Accept and Decline. */
export function inviteButtons(payload: CalendarInvitePayload): InviteButton[] {
	if (payload.method === "CANCEL") return [{ option: "remove", label: "Remove from calendar", primary: true }];
	if (payload.existingEventId) return [{ option: "update", label: "Update event", primary: true }];
	return [
		{ option: "accept", label: "Accept", primary: true },
		{ option: "decline", label: "Decline" },
		...(payload.organizer ? [{ option: "propose" as const, label: "Propose new time" }] : []),
	];
}

/** Warnings shown before the buttons: a sender mismatch or failed authentication. */
export function inviteWarnings(payload: CalendarInvitePayload): string[] {
	const warnings: string[] = [];
	if (!payload.authPassed) warnings.push("Unverified sender: Kite could not confirm who sent this invitation.");
	if (!payload.organizerMatchesSender)
		warnings.push("The organizer's address differs from the sender's. Check it before you reply.");
	return warnings;
}

export type InviteAnswer = { rsvp: "accepted" | "declined" | null; eventActionId: string | null };

/** What stands for an answered invitation, read from the live (not undone, not undo) rows of its actions. */
export function inviteAnswer(suggestionId: string, actions: readonly ActivityAction[]): InviteAnswer {
	const live = actions.filter(
		(action) =>
			action.suggestionId === suggestionId &&
			!action.undoOf &&
			(action.status === "applied" || action.status === "pending"),
	);
	const rsvp = live.find((action) => action.action === "send_rsvp");
	const event = live.find((action) => action.action === "create_event" || action.action === "delete_event");
	return {
		rsvp: rsvp?.variant === "accepted" || rsvp?.variant === "declined" ? rsvp.variant : null,
		eventActionId: event?.id ?? null,
	};
}

export function answeredText(answer: InviteAnswer, payload: CalendarInvitePayload): string {
	if (answer.rsvp === "accepted")
		return answer.eventActionId
			? "You accepted this invitation."
			: "Your acceptance was already sent, but the event is not on your calendar.";
	if (answer.rsvp === "declined") return "You declined this invitation.";
	if (payload.method === "CANCEL") return "Removed from your calendar.";
	return "Your calendar is up to date.";
}
