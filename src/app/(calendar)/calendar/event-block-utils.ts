/** How much of an event the time grid can draw inside its block without clipping a glyph. */
export type EventBlockLayout = {
	/** `none` draws no text (the block only carries its tooltip), `inline` one line, `stacked` title over time. */
	mode: "none" | "inline" | "stacked";
	/** Vertical padding class; the text lines are 16px each, so the padding is what is left over. */
	paddingClass: "py-0" | "py-px" | "py-0.5" | "py-1.5";
};

const LINE_HEIGHT = 16;
/** One line plus 1px of padding above and below: the half-hour event at 36px per hour. */
const INLINE_MIN_HEIGHT = LINE_HEIGHT + 2;
/** Two lines plus 2px of padding above and below: the one-hour event at 36px per hour. */
const STACKED_MIN_HEIGHT = LINE_HEIGHT * 2 + 4;
/** Two lines plus 6px of padding above and below. */
const STACKED_ROOMY_HEIGHT = LINE_HEIGHT * 2 + 12;

export function eventBlockLayout(height: number): EventBlockLayout {
	if (height >= STACKED_ROOMY_HEIGHT) return { mode: "stacked", paddingClass: "py-1.5" };
	if (height >= STACKED_MIN_HEIGHT) return { mode: "stacked", paddingClass: "py-0.5" };
	if (height >= INLINE_MIN_HEIGHT) return { mode: "inline", paddingClass: "py-px" };
	return { mode: "none", paddingClass: "py-0" };
}

/**
 * The grid's dashed edge for a tentative event, drawn inset as an outline so, unlike a border, it takes no
 * room from the 16px lines inside a block that is only 18px or 36px tall.
 */
export const TENTATIVE_BLOCK_CLASSES = "outline outline-1 -outline-offset-1 outline-dashed outline-current";

/**
 * The single line of a short event, as one string so a narrow column cuts it with an ellipsis at the end
 * and the title stays visible. A piece of an event that began on an earlier day cannot show its start,
 * which belongs to that day, so it says when the event ends.
 */
export function inlineEventText(input: {
	title: string;
	startLabel: string;
	endLabel: string;
	startsOnDay: boolean;
}): string {
	return `${input.title}, ${input.startsOnDay ? input.startLabel : `until ${input.endLabel}`}`;
}

/**
 * Keyboard focus on an event block. It must beat the tentative outline above, which would otherwise replace
 * the browser's default focus indicator.
 */
export const EVENT_BLOCK_FOCUS_CLASSES =
	"focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-1 focus-visible:outline-blue-500";
