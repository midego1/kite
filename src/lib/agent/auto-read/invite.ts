import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { bookingEvents, calendarEvents, messageAttachments, users } from "@/db/schema";
import { busyBlocks, proposeSlots } from "@/lib/calendar/availability-utils";
import { ICS_MAX_BYTES, parseIcsInvite, type IcsInvite } from "@/lib/calendar/ics-parse-utils";
import { runCalendarTool } from "@/lib/calendar/tools";
import { isCalendarAttachment } from "./facts-utils";
import type { MessageFacts } from "./facts-types";
import {
	availabilityWindow,
	buildInvitePayload,
	inviteVariant,
	overlappingEvents,
	resolveWorkingHours,
	type ScheduleEvent,
} from "./invite-utils";
import type { CalendarInvitePayload } from "./suggestion-types";

const PROPOSAL_HORIZON_DAYS = 7;

/** The first calendar attachment's text, or null when none exists, it is over the cap, or R2 no longer has it. */
async function readInviteSource(env: CloudflareEnv, messageId: string): Promise<string | null> {
	const rows = await getDb(env)
		.select({
			filename: messageAttachments.filename,
			contentType: messageAttachments.contentType,
			size: messageAttachments.size,
			r2Key: messageAttachments.r2Key,
		})
		.from(messageAttachments)
		.where(eq(messageAttachments.messageId, messageId));
	const attachment = rows.find(isCalendarAttachment);
	if (!attachment || attachment.size > ICS_MAX_BYTES) return null;
	const object = await env.BUCKET.get(attachment.r2Key);
	if (!object || object.size > ICS_MAX_BYTES) return null;
	return new TextDecoder().decode(await object.arrayBuffer());
}

async function schedule(env: CloudflareEnv, reviewer: typeof users.$inferSelect, from: Date, to: Date) {
	const { events } = (await runCalendarTool({ env, user: reviewer }, "get_schedule", {
		start: from.toISOString(),
		end: to.toISOString(),
	})) as { events: ScheduleEvent[] };
	return events;
}

async function proposals(
	env: CloudflareEnv,
	reviewer: typeof users.$inferSelect,
	invite: IcsInvite,
	existingEventId: string | null,
) {
	if (invite.allDay) return [];
	const now = new Date();
	const horizon = new Date(now.getTime() + (PROPOSAL_HORIZON_DAYS + 1) * 86_400_000);
	const events = (await schedule(env, reviewer, now, horizon)).filter((event) => event.seriesId !== existingEventId);
	const [booking] = await getDb(env)
		.select()
		.from(bookingEvents)
		.where(and(eq(bookingEvents.userId, reviewer.id), eq(bookingEvents.enabled, true)))
		.orderBy(asc(bookingEvents.createdAt))
		.limit(1);
	const { workHours, tz } = resolveWorkingHours(booking ?? null, reviewer.timeZone);
	const minutes = Math.max(1, Math.round((Date.parse(invite.end) - Date.parse(invite.start)) / 60_000));
	return proposeSlots(busyBlocks(events, now, horizon), minutes, workHours, tz, 3, PROPOSAL_HORIZON_DAYS, now);
}

/**
 * The calendar_invite payload for a message, computed against the reviewer's own calendar, or null
 * when there is no usable invite: no attachment, over 256 KB, unparsable, an unknown TZID, or
 * nothing new next to the event already stored for the UID.
 */
export async function loadCalendarInvite(
	env: CloudflareEnv,
	input: { messageId: string; reviewerUserId: string; facts: MessageFacts; enabled: boolean },
): Promise<CalendarInvitePayload | null> {
	if (!input.enabled || !input.facts.inviteAttachments.length) return null;
	const source = await readInviteSource(env, input.messageId);
	if (!source) return null;
	const parsed = parseIcsInvite(source);
	if (!parsed.ok) return null;
	const db = getDb(env);
	const [reviewer] = await db.select().from(users).where(eq(users.id, input.reviewerUserId)).limit(1);
	if (!reviewer) return null;
	const [stored] = await db
		.select({ id: calendarEvents.id, icalSequence: calendarEvents.icalSequence })
		.from(calendarEvents)
		.where(and(eq(calendarEvents.userId, reviewer.id), eq(calendarEvents.icalUid, parsed.invite.uid)))
		.limit(1);
	const variant = inviteVariant(parsed.invite, stored ?? null);
	if (!variant) return null;
	const { from, to } = availabilityWindow(parsed.invite);
	const conflicts = overlappingEvents(await schedule(env, reviewer, from, to), parsed.invite, variant.existingEventId);
	return buildInvitePayload({
		invite: parsed.invite,
		variant,
		senderAddress: input.facts.senderAddress,
		authPassed: input.facts.authPassed,
		conflicts,
		proposals: conflicts.length ? await proposals(env, reviewer, parsed.invite, variant.existingEventId) : [],
	});
}
