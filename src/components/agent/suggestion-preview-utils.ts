/** The preview's open delay: long enough that moving the pointer across rows opens nothing. */
export const PREVIEW_OPEN_DELAY_MS = 450;
/** The grace period after leaving the row or the preview, so crossing the gap between them does not close it. */
export const PREVIEW_CLOSE_DELAY_MS = 220;
/** After a close, focus landing on the row (given back after Escape) does not open the preview again for this long. */
export const FOCUS_REOPEN_GUARD_MS = 400;
/** The id of a row's screen-reader hint (ArrowDown reaches the preview's buttons), which the row's link points at. */
export function previewHintId(suggestionId: string): string {
	return `suggestion-preview-hint-${suggestionId}`;
}
/** The characters of the message the preview quotes. */
export const PREVIEW_EXCERPT_CHARS = 320;
/** The characters of a drafted reply the preview shows. */
export const PREVIEW_DRAFT_CHARS = 700;
/**
 * The part of an HTML body that is read for its text; the rest of a very large message is never parsed.
 * @public Consumed by tests that check the cap.
 */
export const PREVIEW_HTML_LIMIT = 200_000;

/** The pointer kinds that hover: a finger has no hover, so touch keeps the row opening the message. */
export function hoversWith(pointerType: string): boolean {
	return pointerType === "mouse" || pointerType === "pen";
}

/**
 * A short plain-text excerpt: quoted lines (`>`) and signature separators go, blank runs and spaces collapse and
 * the rest is cut at a word with an ellipsis. Text only, so nothing of the message's HTML or its remote content
 * reaches the preview.
 */
export function previewExcerpt(text: string | null | undefined, max = PREVIEW_EXCERPT_CHARS): string {
	if (!text) return "";
	const kept = text
		.split(/\r?\n/)
		.filter((line) => !/^\s*>/.test(line))
		.join("\n");
	const cut = kept.search(/^-- ?$/m);
	const plain = (cut >= 0 ? kept.slice(0, cut) : kept)
		.replace(/[ \t\f\v]+/g, " ")
		.replace(/ ?\n ?/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	if (plain.length <= max) return plain;
	const slice = plain.slice(0, max);
	const space = slice.lastIndexOf(" ");
	return `${(space > max * 0.6 ? slice.slice(0, space) : slice).trimEnd()}…`;
}

/** A message body as the stored plain text, or the HTML's text through `toText` when there is no plain part. */
export function bodyText(
	body: { textBody?: string | null; htmlBody?: string | null } | null | undefined,
	toText: (html: string) => string,
): string {
	if (!body) return "";
	if (body.textBody?.trim()) return body.textBody;
	return body.htmlBody ? toText(body.htmlBody.slice(0, PREVIEW_HTML_LIMIT)) : "";
}
