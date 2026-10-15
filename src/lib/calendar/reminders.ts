import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEvents } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { newId } from "@/lib/ids";
import type { CapabilityCallContext, JsonValue } from "@/lib/modules/module-types";
import { reminderChanged, reminderTimes } from "./reminder-utils";
import { emitCalendarWrites } from "./webhook-events";

export type UpsertReminderInput = {
	userId: string;
	key: string;
	title: string;
	description: string;
	date: string;
	time: string;
	durationMinutes: number;
	timeZone: string;
	sourceMessageId: string | null;
};

type RemoveReminderInput = { userId: string; key: string };

const FORBIDDEN = { refused: "forbidden" } as const;

/**
 * The `(user_id, ical_uid)` index is not unique, so the existence check and the insert are one
 * statement: two calls at the same time cannot both see no event and insert one each. The source
 * message is kept only when it is the user's own.
 */
const INSERT_REMINDER = `INSERT INTO calendar_events (id, user_id, title, description, time_zone, starts_at, ends_at, ical_uid, source_message_id, created_at, updated_at)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, (SELECT id FROM messages WHERE id = ? AND user_id = ?), ?, ?
WHERE NOT EXISTS (SELECT 1 FROM calendar_events WHERE user_id = ? AND ical_uid = ?)`;

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

const actsFor = (ctx: CapabilityCallContext, userId: string) => ctx.viewer?.userId === userId;

function reminderEvents(userId: string, key: string) {
	return getDb(getEnv())
		.select()
		.from(calendarEvents)
		.where(and(eq(calendarEvents.userId, userId), eq(calendarEvents.icalUid, key)))
		.orderBy(asc(calendarEvents.createdAt));
}

const answer = (eventId: string, created: boolean): JsonValue => ({
	eventId,
	ref: { kind: "calendar:event", id: eventId },
	created,
});

/**
 * Adds the one event a module keeps under `key` on the viewer's calendar, or moves it to what the
 * caller now says. A repeated call with the same values writes nothing.
 */
export async function upsertReminder(input: UpsertReminderInput, ctx: CapabilityCallContext): Promise<JsonValue> {
	if (!actsFor(ctx, input.userId)) return FORBIDDEN;
	const { startsAt, endsAt } = reminderTimes(input.date, input.time, input.durationMinutes, input.timeZone);
	const next = { title: input.title, description: input.description, timeZone: input.timeZone, startsAt, endsAt };
	const id = newId("evt");
	const now = seconds(new Date());
	const inserted = await getEnv()
		.DB.prepare(INSERT_REMINDER)
		.bind(
			id,
			input.userId,
			next.title,
			next.description,
			next.timeZone,
			seconds(startsAt),
			seconds(endsAt),
			input.key,
			input.sourceMessageId,
			input.userId,
			now,
			now,
			input.userId,
			input.key,
		)
		.run();
	if ((inserted.meta?.changes ?? 0) > 0) {
		await emitCalendarWrites(ctx, [["created", { id, ...next }]]);
		return answer(id, true);
	}
	const [stored] = await reminderEvents(input.userId, input.key).limit(1);
	if (!stored) throw new Error("The reminder event could not be written");
	if (reminderChanged(stored, next)) {
		await getDb(getEnv())
			.update(calendarEvents)
			.set({ ...next, updatedAt: new Date() })
			.where(eq(calendarEvents.id, stored.id));
		await emitCalendarWrites(ctx, [["updated", { id: stored.id, ...next }]]);
	}
	return answer(stored.id, false);
}

/** Deletes the viewer's event kept under `key`, if there is one. */
export async function removeReminder(input: RemoveReminderInput, ctx: CapabilityCallContext): Promise<JsonValue> {
	if (!actsFor(ctx, input.userId)) return FORBIDDEN;
	const stored = await reminderEvents(input.userId, input.key);
	if (stored.length === 0) return { removed: false };
	await getDb(getEnv())
		.delete(calendarEvents)
		.where(and(eq(calendarEvents.userId, input.userId), eq(calendarEvents.icalUid, input.key)));
	await emitCalendarWrites(
		ctx,
		stored.map((row) => ["deleted", row]),
	);
	return { removed: true };
}
