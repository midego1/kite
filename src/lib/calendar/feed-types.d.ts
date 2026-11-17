import type { CalendarRepeat } from "./types";

/** The stored event fields the subscription feed writes; a `calendar_events` row satisfies it. */
export type FeedEvent = {
	id: string;
	title: string;
	description: string;
	location: string;
	startsAt: Date;
	endsAt: Date;
	repeat: CalendarRepeat;
	repeatDays: string;
	repeatAnchorDay: number | null;
	repeatUntil: Date | null;
	excludedOccurrences: string;
	timeZone: string | null;
	status: "confirmed" | "tentative";
	updatedAt?: Date | null;
};

export type FeedOptions = {
	/** Shown by most apps as the subscribed calendar's name. */
	name: string;
	/** The owner's zone: used for events stored without one, and as the calendar's default zone. */
	timeZone: string;
	now?: Date;
};

/** Whether the owner has a subscription link, without the link itself (only its hash is stored). */
export type CalendarFeedStatus = {
	active: boolean;
	createdAt: string | null;
	lastUsedAt: string | null;
};
