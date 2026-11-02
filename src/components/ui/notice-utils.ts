import { ERROR_TONE_CLASS, INFO_TONE_CLASS, SUCCESS_TONE_CLASS, WARNING_TONE_CLASS } from "@/components/notice-styles";
import type { NoticeTone } from "./notice-types";

/** The fill, border and text of each tone (`notice-styles.ts`). */
const NOTICE_TONE_CLASS: Record<NoticeTone, string> = {
	info: INFO_TONE_CLASS,
	success: SUCCESS_TONE_CLASS,
	warning: WARNING_TONE_CLASS,
	error: ERROR_TONE_CLASS,
};

/** The page size of a notice, and the compact size of the sidebar banners: one shape, two sizes. */
const NOTICE_SIZE_CLASS = {
	page: "gap-3 rounded-xl border px-4 py-3 text-sm",
	compact: "gap-2 rounded-lg border px-3 py-2 text-xs",
} as const;

/** The classes of a notice box: its tone and its size. */
export function noticeClass(tone: NoticeTone, compact = false): string {
	return `${NOTICE_SIZE_CLASS[compact ? "compact" : "page"]} ${NOTICE_TONE_CLASS[tone]}`;
}

/** Errors interrupt the screen reader; everything else waits for a pause. */
export function noticeRole(tone: NoticeTone): "alert" | "status" {
	return tone === "error" ? "alert" : "status";
}
