/**
 * Keeps a run such as a date or a size in one piece in a right-to-left interface, where "11:30 AM" would otherwise read
 * "AM 11:30" and "42 KB" read "KB 42". First-strong isolates do what `<bdi>` does, at the formatter every rendering of
 * the value passes through, and text in a left-to-right interface or on the server is left untouched. Not for text that
 * leaves the app (mail bodies): those get the formatter's plain form.
 */
export function isolateDirection(text: string): string {
	return typeof document !== "undefined" && document.documentElement.dir === "rtl" ? `⁨${text}⁩` : text;
}
