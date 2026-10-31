/** One event of the command center's Today card. */
export type TodayLine = {
	id: string;
	/** The start time, or "Now" for an event that is under way. */
	when: string;
	what: string;
	/** The location, otherwise how long the event takes. */
	meta: string;
	href: string;
};

export type TodayLines = {
	lines: TodayLine[];
	/** Events left today beyond the lines shown. */
	more: number;
	/** What the card says without lines: whether today had events that are over, or none at all. */
	empty: "Nothing today" | "Nothing else today";
};
