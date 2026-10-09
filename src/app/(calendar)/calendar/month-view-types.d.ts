import type { CalendarEvent } from "./types";

export type MonthViewProps = {
	date: Date;
	today: Date;
	events: CalendarEvent[];
	onEdit: (event: CalendarEvent) => void;
	onAdd: (day: Date) => void;
	onShowDay: (day: Date) => void;
};
