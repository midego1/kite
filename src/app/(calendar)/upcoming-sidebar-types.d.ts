import type { CalendarEvent } from "./calendar/types";

export type UpcomingSidebarProps = {
	/** The events to list; loaded here when absent (the Booking page). */
	events?: CalendarEvent[];
	onSelect?: (event: CalendarEvent) => void;
	/** Refetch (keeping the current list on screen) when this value changes. */
	refreshKey?: unknown;
};
