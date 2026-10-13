import { normalizeTimeZone } from "@/lib/time/utils";

export type BookingHoursRow = {
	weekdays: string;
	timeRanges: string;
	startTime: string;
	endTime: string;
	timeZone: string;
};

export type WorkingHours = {
	weekdays: number[];
	timeRanges: { startTime: string; endTime: string }[];
	timeZone: string;
};

const CLOCK = /^\d{1,2}:\d{2}$/;
const DEFAULT_WEEKDAYS = [1, 2, 3, 4, 5];

function parseJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

function parseRanges(value: string, fallback: WorkingHours["timeRanges"]): WorkingHours["timeRanges"] {
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

/** The hours an event type is bookable, read tolerantly from its stored JSON columns; null without an event type. */
export function workingHoursOf(row: BookingHoursRow | null): WorkingHours | null {
	if (!row) return null;
	const days = parseJson(row.weekdays);
	return {
		weekdays: Array.isArray(days)
			? days.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6)
			: DEFAULT_WEEKDAYS,
		timeRanges: parseRanges(row.timeRanges, [{ startTime: row.startTime, endTime: row.endTime }]),
		timeZone: normalizeTimeZone(row.timeZone),
	};
}
