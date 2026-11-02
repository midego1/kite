/**
 * The colours of the notices: the page `Notice` and the sidebar banners (`ui/notice.tsx`), the admin cards' icons and
 * the command center's pills. Explicit colours, because the dark theme's inverted amber scale would turn the text
 * bright yellow.
 */
/** The warning text colour alone, for an icon or a label on a plain surface (the admin tiles use the same). */
export const WARNING_TEXT_CLASS = "text-[#8a4b0a] dark:text-[#d4a35a]";
/** The success text colour alone. */
export const SUCCESS_TEXT_CLASS = "text-[#166534] dark:text-[#86c99d]";
/** The error text colour alone. */
export const ERROR_TEXT_CLASS = "text-[#b91c1c] dark:text-[#f19999]";

/** The faint fills of the tones, for a badge, a card icon or a pill on a plain surface. */
export const WARNING_FILL_CLASS = "bg-[#f59e0b]/10";
export const SUCCESS_FILL_CLASS = "bg-[#22c55e]/10";
export const ERROR_FILL_CLASS = "bg-[#ef4444]/10";
/** The hover fill of a button inside a warning notice (its dismiss button). */
export const WARNING_HOVER_FILL_CLASS = "hover:bg-[#f59e0b]/15";

export const WARNING_TONE_CLASS = `border-[#f59e0b]/25 ${WARNING_FILL_CLASS} ${WARNING_TEXT_CLASS}`;
export const SUCCESS_TONE_CLASS = `border-[#22c55e]/25 ${SUCCESS_FILL_CLASS} ${SUCCESS_TEXT_CLASS}`;
export const ERROR_TONE_CLASS = `border-[#ef4444]/25 ${ERROR_FILL_CLASS} ${ERROR_TEXT_CLASS}`;
export const INFO_TONE_CLASS = "border-blue-200/60 bg-blue-50 text-blue-900";

export const NOTICE_LINK_CLASS = "underline underline-offset-2 hover:opacity-80";
