import { and, eq, gte, lt, ne, or } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEvents } from "@/db/schema";
import { newId } from "@/lib/ids";
import { normalizeTimeZone, zonedDateFields } from "@/lib/time/utils";
import { busyBlocks } from "./availability-utils";
import { normalizeCalendarColor } from "./colors";
import { DEFAULT_REPEAT_DAYS, normalizeCalendarRepeatDays, parseCalendarOccurrenceId } from "./recurrence";
import { expandToolEvents } from "./tool-occurrences";
import { calendarToolSchemas, type calendarUpdateSchema } from "./tool-schemas";
import type { z } from "zod";
import type { CalendarToolContext, CalendarToolName } from "./tool-types";

function dates(start: string, end: string) {
	const from = new Date(start);
	const to = new Date(end);
	if (to <= from || to.getTime() - from.getTime() > 90 * 86_400_000)
		throw new Error("Choose a positive range of at most 90 days");
	return { from, to };
}

async function eventsInRange(context: CalendarToolContext, from: Date, to: Date) {
	return getDb(context.env)
		.select()
		.from(calendarEvents)
		.where(
			and(
				eq(calendarEvents.userId, context.user.id),
				lt(calendarEvents.startsAt, to),
				or(gte(calendarEvents.endsAt, from), ne(calendarEvents.repeat, "none")),
			),
		);
}

export async function runCalendarTool(
	context: CalendarToolContext,
	name: CalendarToolName,
	rawInput: unknown,
): Promise<unknown> {
	const input = calendarToolSchemas[name].parse(rawInput) as Record<string, unknown>;
	const db = getDb(context.env);
	if (name === "get_calendars")
		return {
			calendars: [
				{
					id: "personal",
					name: "Personal calendar",
					timeZone: normalizeTimeZone(context.user.timeZone),
					writable: true,
				},
			],
		};
	if (name === "get_schedule" || name === "search_events" || name === "find_free_time") {
		const { from, to } = dates(input.start as string, input.end as string);
		const events = expandToolEvents(await eventsInRange(context, from, to), from, to);
		if (name === "get_schedule") return { events, truncated: events.length >= 500 };
		if (name === "search_events") {
			const query = (input.query as string).toLocaleLowerCase();
			const matches = events.filter((event) =>
				[event.title, event.description, event.location].some((value) => value.toLocaleLowerCase().includes(query)),
			);
			return {
				events: matches.slice(0, input.limit as number),
				truncated: events.length >= 500 || matches.length > (input.limit as number),
			};
		}
		const duration = (input.durationMinutes as number) * 60_000;
		const busy = busyBlocks(events, from, to);
		const slots: Array<{ startsAt: string; endsAt: string }> = [];
		let cursor = from.getTime();
		for (const block of [...busy, { start: to.getTime(), end: to.getTime() }]) {
			if (block.start - cursor >= duration)
				slots.push({ startsAt: new Date(cursor).toISOString(), endsAt: new Date(block.start).toISOString() });
			cursor = Math.max(cursor, block.end);
			if (slots.length >= (input.limit as number)) break;
		}
		return { slots, truncated: events.length >= 500 };
	}
	if (name === "get_event") {
		const occurrence = parseCalendarOccurrenceId(input.eventId as string);
		const [event] = await db
			.select()
			.from(calendarEvents)
			.where(
				and(
					eq(calendarEvents.userId, context.user.id),
					eq(calendarEvents.id, occurrence?.seriesId ?? (input.eventId as string)),
				),
			)
			.limit(1);
		if (!event) throw new Error("Event not found");
		if (!occurrence) return { event };
		const found = expandToolEvents([event], occurrence.startsAt, new Date(occurrence.startsAt.getTime() + 1)).find(
			(item) => item.id === input.eventId,
		);
		if (!found) throw new Error("Occurrence not found");
		return { event: found };
	}
	if (name === "create_event") {
		const startsAt = new Date(input.startsAt as string);
		const endsAt = new Date(input.endsAt as string);
		if (endsAt <= startsAt) throw new Error("Event end must be after its start");
		const timeZone = normalizeTimeZone((input.timeZone as string) ?? context.timeZone ?? context.user.timeZone);
		const repeatDays = normalizeCalendarRepeatDays(input.repeatDays ?? DEFAULT_REPEAT_DAYS);
		if (input.repeat === "weekdays" && !repeatDays.length) throw new Error("Choose at least one weekday");
		const event = {
			id: newId("evt"),
			userId: context.user.id,
			title: input.title as string,
			startsAt,
			endsAt,
			description: (input.description as string) ?? "",
			location: (input.location as string) ?? "",
			timeZone,
			color: normalizeCalendarColor(input.color as string | undefined),
			repeat: input.repeat as "none" | "daily" | "weekly" | "monthly" | "weekdays",
			repeatDays: JSON.stringify(repeatDays),
			attendees: JSON.stringify(input.attendees ?? []),
			repeatAnchorDay: input.repeat === "monthly" ? zonedDateFields(startsAt, timeZone).getUTCDate() : null,
		};
		await db.insert(calendarEvents).values(event);
		return { eventId: event.id, status: "created" };
	}
	if (name === "update_events") {
		const updates = input.updates as z.infer<typeof calendarUpdateSchema>[];
		const ids = updates.map((item) => item.eventId);
		if (new Set(ids).size !== ids.length || ids.some((value) => parseCalendarOccurrenceId(value)))
			throw new Error("Use unique series IDs for updates");
		const existing = await Promise.all(
			ids.map(
				async (eventId) =>
					(
						await db
							.select()
							.from(calendarEvents)
							.where(and(eq(calendarEvents.id, eventId), eq(calendarEvents.userId, context.user.id)))
							.limit(1)
					)[0],
			),
		);
		if (existing.some((row) => !row)) throw new Error("Event not found");
		for (const [index, item] of updates.entries()) {
			const row = existing[index]!;
			if (
				(item.endsAt ? new Date(item.endsAt) : row.endsAt) <= (item.startsAt ? new Date(item.startsAt) : row.startsAt)
			)
				throw new Error("Event end must be after its start");
			if (
				(item.repeat ?? row.repeat) === "weekdays" &&
				!normalizeCalendarRepeatDays(item.repeatDays ?? JSON.parse(row.repeatDays)).length
			)
				throw new Error("Choose at least one weekday");
		}
		for (const [index, item] of updates.entries()) {
			const row = existing[index]!;
			const startsAt = item.startsAt ? new Date(item.startsAt) : row.startsAt;
			const endsAt = item.endsAt ? new Date(item.endsAt) : row.endsAt;
			const timeZone = item.timeZone ? normalizeTimeZone(item.timeZone) : normalizeTimeZone(row.timeZone);
			await db
				.update(calendarEvents)
				.set({
					title: item.title ?? row.title,
					description: item.description ?? row.description,
					location: item.location ?? row.location,
					startsAt,
					endsAt,
					timeZone,
					color: item.color ? normalizeCalendarColor(item.color) : row.color,
					repeat: item.repeat ?? row.repeat,
					repeatDays: item.repeatDays ? JSON.stringify(normalizeCalendarRepeatDays(item.repeatDays)) : row.repeatDays,
					repeatAnchorDay:
						(item.repeat ?? row.repeat) === "monthly" ? zonedDateFields(startsAt, timeZone).getUTCDate() : null,
					attendees: item.attendees ? JSON.stringify(item.attendees) : row.attendees,
					updatedAt: new Date(),
				})
				.where(and(eq(calendarEvents.id, row.id), eq(calendarEvents.userId, context.user.id)));
		}
		return { eventIds: ids, status: "updated" };
	}
	const ids = input.eventIds as string[];
	if (new Set(ids).size !== ids.length || ids.some((value) => parseCalendarOccurrenceId(value)))
		throw new Error("Use unique series IDs for deletion");
	const existing = await Promise.all(
		ids.map(
			async (eventId) =>
				(
					await db
						.select({ id: calendarEvents.id })
						.from(calendarEvents)
						.where(and(eq(calendarEvents.id, eventId), eq(calendarEvents.userId, context.user.id)))
						.limit(1)
				)[0],
		),
	);
	if (existing.some((row) => !row)) throw new Error("Event not found");
	for (const eventId of ids)
		await db
			.delete(calendarEvents)
			.where(and(eq(calendarEvents.id, eventId), eq(calendarEvents.userId, context.user.id)));
	return { eventIds: ids, status: "deleted" };
}
