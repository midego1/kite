/** Stands in for the number while a translated message is split around it; never shown. */
export const COUNT_MARKER = "⁣";

/**
 * Splits a translated "N selected"-style message into the words before the number, the number itself
 * and the words after it, for any word order ("5 selected", "المحدد: 5"). `withNumber` is the message
 * formatted with the real count, `withMarker` the same message formatted with `COUNT_MARKER` for it;
 * the number is whatever the real formatting put there (digits, separators, locale digits). A message
 * with no placeholder comes back whole as `before`.
 */
export function splitCountMessage(
	withNumber: string,
	withMarker: string,
): { before: string; number: string; after: string } {
	const at = withMarker.indexOf(COUNT_MARKER);
	if (at < 0) return { before: withNumber, number: "", after: "" };
	const before = withMarker.slice(0, at);
	const after = withMarker.slice(at + COUNT_MARKER.length);
	if (!withNumber.startsWith(before) || !withNumber.endsWith(after) || withNumber.length < before.length + after.length)
		return { before: withNumber, number: "", after: "" };
	return { before, number: withNumber.slice(before.length, withNumber.length - after.length), after };
}
