import type { NoticeTone } from "./notice-types";

/** The fill, border and text of each tone; the amber and red pairs keep AA contrast in both themes. */
export const NOTICE_TONE_CLASS: Record<NoticeTone, string> = {
	info: "border-blue-200/60 bg-blue-50 text-blue-900",
	success: "border-green-600/20 bg-green-600/10 text-green-800",
	warning: "border-[#f59e0b]/25 bg-[#f59e0b]/10 text-[#8a4b0a] dark:text-[#d4a35a]",
	error: "border-[#ef4444]/25 bg-[#ef4444]/10 text-[#b91c1c] dark:text-[#f19999]",
};

/** Errors interrupt the screen reader; everything else waits for a pause. */
export function noticeRole(tone: NoticeTone): "alert" | "status" {
	return tone === "error" ? "alert" : "status";
}
