/**
 * The compact notices in the sidebar (and over the page on phones), after Zero's warnings: a muted amber card
 * with explicit colours, because the dark theme's inverted amber scale would turn the text bright yellow.
 */
/** The warning text colour alone, for an icon or a label on a plain surface (the admin tiles use the same). */
export const WARNING_TEXT_CLASS = "text-[#8a4b0a] dark:text-[#d4a35a]";
/** The success text colour alone. */
export const SUCCESS_TEXT_CLASS = "text-[#166534] dark:text-[#86c99d]";

export const WARNING_TONE_CLASS = `border-[#f59e0b]/25 bg-[#f59e0b]/10 ${WARNING_TEXT_CLASS}`;
export const SUCCESS_TONE_CLASS = `border-[#22c55e]/25 bg-[#22c55e]/10 ${SUCCESS_TEXT_CLASS}`;
export const ERROR_TONE_CLASS = "border-[#ef4444]/25 bg-[#ef4444]/10 text-[#b91c1c] dark:text-[#f19999]";
export const INFO_TONE_CLASS = "border-blue-200/60 bg-blue-50 text-blue-900";

/** The four tones share one shape: a bordered, tinted box; the page `Notice` component builds on the same classes. */
export const WARNING_NOTICE_CLASS = `flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${WARNING_TONE_CLASS}`;

export const SUCCESS_NOTICE_CLASS = `flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${SUCCESS_TONE_CLASS}`;

export const NOTICE_LINK_CLASS = "underline underline-offset-2 hover:opacity-80";
