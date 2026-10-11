import { dateFromZonedFields, normalizeTimeZone, zonedDateFields } from "@/lib/time/utils";

export type BusyBlock = { start: number; end: number };
export type WorkHours = { weekdays: number[]; ranges: Array<{ startTime: string; endTime: string }> };
export type TimedEvent = { startsAt: string; endsAt: string };

const SLOT_STEP_MS = 30 * 60_000;

/** Clamp events to [from, to] and order them by start, as `find_free_time` always did. */
export function busyBlocks(events: TimedEvent[], from: Date, to: Date): BusyBlock[] {
	return events
		.map((event) => ({
			start: Math.max(from.getTime(), Date.parse(event.startsAt)),
			end: Math.min(to.getTime(), Date.parse(event.endsAt)),
		}))
		.sort((a, b) => a.start - b.start);
}

export function findConflicts<T extends TimedEvent>(events: T[], start: Date, end: Date): T[] {
	return events.filter(
		(event) => Date.parse(event.startsAt) < end.getTime() && Date.parse(event.endsAt) > start.getTime(),
	);
}

function parseClock(value: string): number | null {
	const match = /^(\d{1,2}):(\d{2})$/.exec(value);
	if (!match || Number(match[1]) > 24 || Number(match[2]) > 59) return null;
	return Number(match[1]) * 60 + Number(match[2]);
}

function wallInstant(day: Date, minutes: number, tz: string): Date {
	const fields = new Date(day);
	fields.setUTCHours(0, minutes, 0, 0);
	return dateFromZonedFields(fields, tz);
}

/**
 * Free slots of `durationMin` inside working hours. Windows are built from local wall-clock times so a DST change
 * keeps the local hours; slots start on a 30-minute grid from the window start and never overlap each other.
 */
export function proposeSlots(
	busy: BusyBlock[],
	durationMin: number,
	workHours: WorkHours,
	tz: string,
	count = 3,
	horizonDays = 7,
	from = new Date(),
): Array<{ start: string; end: string }> {
	const zone = normalizeTimeZone(tz);
	const duration = durationMin * 60_000;
	const horizonEnd = from.getTime() + horizonDays * 86_400_000;
	const today = zonedDateFields(from, zone);
	today.setUTCHours(0, 0, 0, 0);
	const slots: Array<{ start: string; end: string }> = [];
	for (let offset = 0; offset <= horizonDays && slots.length < count; offset++) {
		const day = new Date(today);
		day.setUTCDate(day.getUTCDate() + offset);
		if (!workHours.weekdays.includes(day.getUTCDay())) continue;
		for (const range of workHours.ranges) {
			const startMinutes = parseClock(range.startTime);
			const endMinutes = parseClock(range.endTime);
			if (startMinutes === null || endMinutes === null || endMinutes <= startMinutes) continue;
			const windowStart = wallInstant(day, startMinutes, zone).getTime();
			const windowEnd = wallInstant(day, endMinutes, zone).getTime();
			let cursor = windowStart;
			if (cursor < from.getTime()) cursor += Math.ceil((from.getTime() - cursor) / SLOT_STEP_MS) * SLOT_STEP_MS;
			while (cursor + duration <= windowEnd && cursor < horizonEnd && slots.length < count) {
				const clash = busy.find((block) => block.start < cursor + duration && block.end > cursor);
				if (clash) {
					cursor += SLOT_STEP_MS;
					continue;
				}
				slots.push({ start: new Date(cursor).toISOString(), end: new Date(cursor + duration).toISOString() });
				cursor += duration;
			}
		}
	}
	return slots;
}
