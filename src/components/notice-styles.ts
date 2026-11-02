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

export const WARNING_TONE_CLASS = `border-[#f59e0b]/25 bg-[#f59e0b]/10 ${WARNING_TEXT_CLASS}`;
export const SUCCESS_TONE_CLASS = `border-[#22c55e]/25 bg-[#22c55e]/10 ${SUCCESS_TEXT_CLASS}`;
export const ERROR_TONE_CLASS = `border-[#ef4444]/25 bg-[#ef4444]/10 ${ERROR_TEXT_CLASS}`;
export const INFO_TONE_CLASS = "border-blue-200/60 bg-blue-50 text-blue-900";

export const NOTICE_LINK_CLASS = "underline underline-offset-2 hover:opacity-80";
