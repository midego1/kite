import type { CalendarView } from "./types";

export type CalendarHeaderMenuProps = {
	view: CalendarView;
	onView: (view: CalendarView) => void;
	onToday: () => void;
	onSubscribe: () => void;
};
