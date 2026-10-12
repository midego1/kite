import { formatUserDate } from "@/lib/time/utils";

/** Shown instead of a time when the build embedded none (local dev without the build defines). */
const UNKNOWN_BUILD_TIME_LABEL = "development";

const UPDATE_FORMAT: Intl.DateTimeFormatOptions = {
	day: "numeric",
	month: "short",
	hour: "2-digit",
	minute: "2-digit",
};

/**
 * "12 Oct, 14:20" in the reader's locale and time zone. The label depends on
 * the browser, so callers render it after mount to keep hydration in step with
 * the server; "development" is returned when the build recorded no usable time.
 */
export function formatBuildTime(value: string | null | undefined): string {
	if (!value) return UNKNOWN_BUILD_TIME_LABEL;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return UNKNOWN_BUILD_TIME_LABEL;
	try {
		return formatUserDate(date, UPDATE_FORMAT);
	} catch {
		// An exotic time zone or a runtime without the requested locale data.
		return date.toISOString().slice(0, 16).replace("T", " ");
	}
}
