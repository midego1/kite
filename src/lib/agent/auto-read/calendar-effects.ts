import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEvents, domains, mailboxes, messages } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/types";
import { createCalendarReply } from "@/lib/calendar/utils";
import { sendEmail } from "@/lib/email/send";
import { resolveComposerSendTime } from "@/lib/email/undo-send-utils";
import { newId } from "@/lib/ids";
import { AgentActionError } from "./action-error";
import type { ActionEffect } from "./actions-types";
import { retireLiveRows } from "./calendar-state";
import {
	inviteEventValues,
	rsvpSubject,
	rsvpText,
	serializeEventRow,
	snapshotEvent,
	snapshotValues,
	type EventSnapshot,
	type Partstat,
} from "./invite-actions-utils";
import type { CalendarInvitePayload } from "./suggestion-types";

type EventRow = typeof calendarEvents.$inferSelect;

/** The reviewer's stored event: by id when the suggestion names one, otherwise by the invitation's UID. */
export async function findInviteEvent(
	env: CloudflareEnv,
	userId: string,
	key: { id?: string | null; uid: string },
): Promise<EventRow | null> {
	const [row] = await getDb(env)
		.select()
		.from(calendarEvents)
		.where(
			and(
				eq(calendarEvents.userId, userId),
				key.id ? eq(calendarEvents.id, key.id) : eq(calendarEvents.icalUid, key.uid),
			),
		)
		.limit(1);
	return row ?? null;
}

async function eventExists(env: CloudflareEnv, eventId: string): Promise<boolean> {
	const [row] = await getDb(env)
		.select({ id: calendarEvents.id })
		.from(calendarEvents)
		.where(eq(calendarEvents.id, eventId))
		.limit(1);
	return !!row;
}

/** Adds the invitation to the reviewer's calendar under an id chosen up front, so a resumed action finds it. */
export function createEventEffect(input: {
	env: CloudflareEnv;
	reviewerUserId: string;
	messageId: string;
	payload: CalendarInvitePayload;
}): ActionEffect {
	const { env, payload } = input;
	return {
		ids: { eventId: newId("evt") },
		async apply(ids) {
			const existing = await findInviteEvent(env, input.reviewerUserId, { uid: payload.uid });
			if (existing) return { eventId: existing.id };
			await getDb(env)
				.insert(calendarEvents)
				.values(
					inviteEventValues(payload, {
						id: ids.eventId!,
						userId: input.reviewerUserId,
						messageId: input.messageId,
						now: new Date(),
					}),
				)
				.onConflictDoNothing();
			return { eventId: ids.eventId! };
		},
		async check(ids) {
			return ids.eventId && (await eventExists(env, ids.eventId)) ? { eventId: ids.eventId } : null;
		},
	};
}

/** Moves the stored event to a newer SEQUENCE; the write itself refuses an equal or older one. */
export async function updateEventEffect(input: {
	env: CloudflareEnv;
	reviewerUserId: string;
	payload: CalendarInvitePayload;
}): Promise<ActionEffect> {
	const { env, payload } = input;
	const stored = await findInviteEvent(env, input.reviewerUserId, { id: payload.existingEventId, uid: payload.uid });
	if (!stored) throw new AgentActionError("The event is no longer on your calendar", 409);
	const next: EventSnapshot = {
		...snapshotEvent(stored),
		title: payload.summary.trim() || stored.title,
		location: payload.location ?? "",
		timeZone: payload.tz,
		startsAt: Date.parse(payload.start),
		endsAt: Date.parse(payload.end),
		icalSequence: payload.sequence,
		organizer: payload.organizer ?? stored.organizer,
	};
	return {
		ids: { eventId: stored.id },
		before: snapshotEvent(stored),
		async apply(ids) {
			const updated = await getDb(env)
				.update(calendarEvents)
				.set({ ...snapshotValues(next), updatedAt: new Date() })
				.where(
					and(
						eq(calendarEvents.id, ids.eventId!),
						// An older or equal SEQUENCE must never overwrite a newer stored event.
						sql`coalesce(${calendarEvents.icalSequence}, 0) < ${payload.sequence}`,
					),
				)
				.returning({ id: calendarEvents.id });
			if (updated.length === 0) throw new Error("A newer version of this event is already on the calendar");
			return { eventId: ids.eventId! };
		},
		async check(ids) {
			const row = await findInviteEvent(env, input.reviewerUserId, { id: ids.eventId, uid: payload.uid });
			return row?.icalSequence === payload.sequence ? { eventId: row.id } : null;
		},
	};
}

/** Deletes the stored event; `before` keeps the whole row so undo can put it back. */
export function deleteEventEffect(env: CloudflareEnv, stored: EventRow): ActionEffect {
	return {
		ids: { eventId: stored.id },
		before: serializeEventRow(stored),
		async apply(ids) {
			await getDb(env).delete(calendarEvents).where(eq(calendarEvents.id, ids.eventId!));
			return { eventId: ids.eventId! };
		},
		async check(ids) {
			return (await eventExists(env, ids.eventId!)) ? null : { eventId: ids.eventId! };
		},
	};
}

async function mailboxAddress(env: CloudflareEnv, mailboxId: string): Promise<string> {
	const [row] = await getDb(env)
		.select({ localPart: mailboxes.localPart, hostname: domains.hostname })
		.from(mailboxes)
		.innerJoin(domains, eq(domains.id, mailboxes.domainId))
		.where(eq(mailboxes.id, mailboxId))
		.limit(1);
	if (!row) throw new AgentActionError("Mailbox not found", 404);
	return `${row.localPart}@${row.hostname}`.toLowerCase();
}

async function messageExists(env: CloudflareEnv, messageId: string): Promise<boolean> {
	const [row] = await getDb(env).select({ id: messages.id }).from(messages).where(eq(messages.id, messageId)).limit(1);
	return !!row;
}

export type RsvpInput = {
	env: CloudflareEnv;
	actor: SessionUser;
	suggestionId: string;
	mailboxId: string;
	payload: CalendarInvitePayload;
	partstat: Partstat;
	source: { id: string; providerMessageId: string | null };
};

/**
 * Sends the METHOD:REPLY to the ORGANIZER only, with an id chosen up front so a resumed action finds
 * the message it already wrote. A later reply replaces an earlier one, so the opposite live row becomes undone.
 */
export function rsvpEffect(input: RsvpInput): ActionEffect {
	const { env, payload } = input;
	return {
		ids: { messageId: newId("msg") },
		async apply(ids) {
			const attendee = await mailboxAddress(env, input.mailboxId);
			const file = createCalendarReply({
				uid: payload.uid,
				organizer: payload.organizer!,
				attendee,
				partstat: input.partstat === "accepted" ? "ACCEPTED" : "DECLINED",
				sequence: payload.sequence,
				summary: payload.summary,
			});
			await sendEmail(env, {
				userId: input.actor.id,
				mailboxId: input.mailboxId,
				from: attendee,
				to: payload.organizer!,
				subject: rsvpSubject(input.partstat, payload.summary),
				text: rsvpText(input.partstat, payload.summary),
				inReplyTo: input.source.providerMessageId,
				references: input.source.providerMessageId,
				messageId: ids.messageId,
				scheduledAt: resolveComposerSendTime(undefined, input.actor.undoSendSeconds).scheduledAt,
				attachments: [{ filename: "invite.ics", type: "text/calendar; method=REPLY; charset=utf-8", content: file }],
			});
			await retireLiveRows(env, {
				suggestionId: input.suggestionId,
				rows: [{ action: "send_rsvp", variant: input.partstat === "accepted" ? "declined" : "accepted" }],
				userId: input.actor.id,
			});
			return { messageId: ids.messageId, partstat: input.partstat };
		},
		async check(ids) {
			return (await messageExists(env, ids.messageId!))
				? { messageId: ids.messageId!, partstat: input.partstat }
				: null;
		},
	};
}
