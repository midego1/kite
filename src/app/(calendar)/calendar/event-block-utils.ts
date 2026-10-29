/** How much of an event the time grid can draw inside its block without clipping a glyph. */
export type EventBlockLayout = {
	/** `none` draws no text (the block only carries its tooltip), `inline` one line, `stacked` title over time. */
	mode: "none" | "inline" | "stacked";
	/** Vertical padding class; the text lines are 16px each, so the padding is what is left over. */
	paddingClass: "py-0" | "py-px" | "py-0.5" | "py-1.5";
};

const LINE_HEIGHT = 16;
/** One line plus 1px of padding above and below: the half-hour event at 36px per hour. */
export const INLINE_MIN_HEIGHT = LINE_HEIGHT + 2;
/** Two lines plus 2px of padding above and below: the one-hour event at 36px per hour. */
export const STACKED_MIN_HEIGHT = LINE_HEIGHT * 2 + 4;
/** Two lines plus 6px of padding above and below. */
const STACKED_ROOMY_HEIGHT = LINE_HEIGHT * 2 + 12;

export function eventBlockLayout(height: number): EventBlockLayout {
	if (height >= STACKED_ROOMY_HEIGHT) return { mode: "stacked", paddingClass: "py-1.5" };
	if (height >= STACKED_MIN_HEIGHT) return { mode: "stacked", paddingClass: "py-0.5" };
	if (height >= INLINE_MIN_HEIGHT) return { mode: "inline", paddingClass: "py-px" };
	return { mode: "none", paddingClass: "py-0" };
}

/** What follows the title on the single line of a short event; the title truncates, this stays whole. */
export function inlineEventSuffix(startLabel: string): string {
	return `, ${startLabel}`;
}
