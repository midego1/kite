import { ERROR_TONE_CLASS, INFO_TONE_CLASS, SUCCESS_TONE_CLASS, WARNING_TONE_CLASS } from "@/components/notice-styles";
import type { NoticeTone } from "./notice-types";

/** The fill, border and text of each tone, shared with the sidebar banners (`notice-styles.ts`). */
export const NOTICE_TONE_CLASS: Record<NoticeTone, string> = {
	info: INFO_TONE_CLASS,
	success: SUCCESS_TONE_CLASS,
	warning: WARNING_TONE_CLASS,
	error: ERROR_TONE_CLASS,
};

/** Errors interrupt the screen reader; everything else waits for a pause. */
export function noticeRole(tone: NoticeTone): "alert" | "status" {
	return tone === "error" ? "alert" : "status";
}
