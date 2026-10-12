import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEvents, messageAttachments, users } from "@/db/schema";
import { busyBlocks, proposeSlots } from "@/lib/calendar/availability-utils";
import { ICS_MAX_BYTES, parseIcsInvite, type IcsInvite } from "@/lib/calendar/ics-parse-utils";
import { runCalendarTool } from "@/lib/calendar/tools";
import { moduleHost } from "@/lib/modules/host";
import type { CapabilityCallContext } from "@/lib/modules/module-types";
import { isCalendarAttachment } from "./facts-utils";
import {
	availabilityWindow,
	buildInvitePayload,
	inviteVariant,
	localizeAllDay,
	overlappingEvents,
	resolveWorkingHours,
	type ScheduleEvent,
	type ServiceWorkingHours,
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

/**
 * Booking's working hours when Booking is on for the reviewer and has event types, otherwise the
 * default week; a Booking that is off never fails the step. The question is asked as the reviewer,
 * whoever is answering the invitation, because it is the reviewer's Booking that decides.
 */
async function reviewerWorkingHours(ctx: CapabilityCallContext, reviewer: typeof users.$inferSelect) {
	const viewer = { userId: reviewer.id, role: reviewer.role, isPrimaryAdmin: reviewer.isPrimaryAdmin };
	const answer = await moduleHost
		.invoke({ ...ctx, viewer }, "booking", "workingHours", { userId: reviewer.id })
		.catch(() => null);
	const hours = answer?.ok ? (answer.output as ServiceWorkingHours | null) : null;
	return resolveWorkingHours(hours, reviewer.timeZone);
}

async function proposals(
	env: CloudflareEnv,
	ctx: CapabilityCallContext,
	reviewer: typeof users.$inferSelect,
	invite: Pick<IcsInvite, "allDay" | "start" | "end">,
	existingEventId: string | null,
) {
	if (invite.allDay) return [];
	const now = new Date();
	const horizon = new Date(now.getTime() + (PROPOSAL_HORIZON_DAYS + 1) * 86_400_000);
	const events = (await schedule(env, reviewer, now, horizon)).filter((event) => event.seriesId !== existingEventId);
	const { workHours, tz } = await reviewerWorkingHours(ctx, reviewer);
	const minutes = Math.max(1, Math.round((Date.parse(invite.end) - Date.parse(invite.start)) / 60_000));
	return proposeSlots(busyBlocks(events, now, horizon), minutes, workHours, tz, 3, PROPOSAL_HORIZON_DAYS, now);
}

/** Free slots for an accepted invitation's length when its stored proposals are empty (no conflict was found). */
export async function proposeSlotsForInvite(
	env: CloudflareEnv,
	ctx: CapabilityCallContext,
	reviewerUserId: string,
	payload: Pick<CalendarInvitePayload, "start" | "end" | "existingEventId">,
) {
	const [reviewer] = await getDb(env).select().from(users).where(eq(users.id, reviewerUserId)).limit(1);
	if (!reviewer) return [];
	return proposals(env, ctx, reviewer, { allDay: false, ...payload }, payload.existingEventId ?? null);
}

/**
 * The calendar_invite payload for a message, computed against the reviewer's own calendar, or null
 * when there is no usable invite: no attachment, over 256 KB, unparsable, an unknown TZID, or
 * nothing new next to the event already stored for the UID.
 */
export async function loadCalendarInvite(
	env: CloudflareEnv,
	ctx: CapabilityCallContext,
	input: { messageId: string; reviewerUserId: string; senderAddress: string; authPassed: boolean },
): Promise<CalendarInvitePayload | null> {
	const source = await readInviteSource(env, input.messageId);
	if (!source) return null;
	const parsed = parseIcsInvite(source);
	if (!parsed.ok) return null;
	const db = getDb(env);
	const [reviewer] = await db.select().from(users).where(eq(users.id, input.reviewerUserId)).limit(1);
	if (!reviewer) return null;
	const invite = localizeAllDay(parsed.invite, reviewer.timeZone);
	const [stored] = await db
		.select({ id: calendarEvents.id, icalSequence: calendarEvents.icalSequence })
		.from(calendarEvents)
		.where(and(eq(calendarEvents.userId, reviewer.id), eq(calendarEvents.icalUid, invite.uid)))
		.limit(1);
	const variant = inviteVariant(invite, stored ?? null);
	if (!variant) return null;
	const { from, to } = availabilityWindow(invite);
	const conflicts = overlappingEvents(await schedule(env, reviewer, from, to), invite, variant.existingEventId);
	return buildInvitePayload({
		invite,
		variant,
		senderAddress: input.senderAddress,
		authPassed: input.authPassed,
		conflicts,
		proposals: conflicts.length ? await proposals(env, ctx, reviewer, invite, variant.existingEventId) : [],
	});
}
