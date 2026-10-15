import { dateFromZonedFields } from "@/lib/time/utils";

/**
 * A reminder key: `<namespace>:<id>`. It has no `@`, so it can never equal the UID of an accepted
 * invitation stored in the same `ical_uid` column.
 */
export const REMINDER_KEY_PATTERN = /^[a-z][a-z0-9-]*:[A-Za-z0-9_-]{1,100}$/;

/** The start and end of a reminder at the wall-clock `time` on `date` in `timeZone`, DST included. */
export function reminderTimes(
	date: string,
	time: string,
	durationMinutes: number,
	timeZone: string,
): { startsAt: Date; endsAt: Date } {
	const startsAt = dateFromZonedFields(new Date(`${date}T${time}:00.000Z`), timeZone);
	return { startsAt, endsAt: new Date(startsAt.getTime() + durationMinutes * 60_000) };
}

export type ReminderFields = {
	title: string;
	description: string;
	timeZone: string | null;
	startsAt: Date;
	endsAt: Date;
};

/** Whether the stored event differs from what the reminder should now say. */
export function reminderChanged(stored: ReminderFields, next: ReminderFields): boolean {
	return (
		stored.title !== next.title ||
		stored.description !== next.description ||
		stored.timeZone !== next.timeZone ||
		stored.startsAt.getTime() !== next.startsAt.getTime() ||
		stored.endsAt.getTime() !== next.endsAt.getTime()
	);
}
