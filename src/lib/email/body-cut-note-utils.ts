/** Said at the end of a body Kite keeps only the start of; the raw message in the Mail store holds all of it. */
const BODY_CUT_NOTE =
	"This message is longer than Kite shows. The rest is in the original message: use Show original to download it.";

/** How a text body ends with the note. ASCII, so its length is its size in UTF-8 bytes. */
export const TEXT_CUT_NOTE = `\n\n[${BODY_CUT_NOTE}]`;

/** `html` with the note at its end, inside the one element that carries the root direction when there is one. */
export function withHtmlCutNote(html: string): string {
	const note = `<hr><p>${BODY_CUT_NOTE}</p>`;
	const wrapped = /^<div dir="(?:ltr|rtl)">/.test(html) && html.endsWith("</div>");
	return wrapped ? `${html.slice(0, -"</div>".length)}${note}</div>` : `${html}${note}`;
}
