/**
 * Helpers for putting untrusted text (mail, pasted text, settings typed by users) into a model prompt.
 * Mail goes inside nonce-delimited blocks; anything that could fake those delimiters is removed first.
 */

const INVISIBLE_CHARACTERS = /[\u{E0000}-\u{E007F}\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/gu;
// C0 controls except tab, line feed and carriage return, DEL and C1 controls.
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const DELIMITER_LIKE = /[<>]{3,}|\bnonce\s*[:=]\s*\S*/gi;

/** A fresh random nonce for one prompt's untrusted blocks. */
export function createNonce(): string {
	return crypto.randomUUID().replace(/-/g, "");
}

/**
 * Removes anything that could pass for the prompt's own delimiters: runs of three or more angle
 * brackets (after NFKC folds look-alikes), `nonce=` fragments, the live nonce, invisible tag/bidi
 * characters and control characters other than tab and line breaks. The characters that could sit
 * inside a delimiter go first, and the whole pass repeats until stable, so no removal can join the
 * rest into a new delimiter.
 */
export function stripDelimiters(value: string, nonce?: string): string {
	let text = value;
	let previous: string;
	do {
		previous = text;
		text = text.normalize("NFKC").replace(INVISIBLE_CHARACTERS, "").replace(CONTROL_CHARACTERS, "");
		if (nonce) text = text.split(nonce).join("");
		text = text.replace(DELIMITER_LIKE, "");
	} while (text !== previous);
	return text;
}

/** Labels every http(s) URL as untrusted text, so the model does not treat it as a link to follow. */
export function markUntrustedLinks(text: string): string {
	return text.replace(/\bhttps?:\/\/[^\s()[\]"']+/gi, (url) => `[untrusted link: ${url}]`);
}

/**
 * One untrusted block: `<<<LABEL key=value ... nonce=N>>>`, the text, then `<<<END N>>>`. Attribute values
 * keep only word characters, dots and hyphens; the caller strips delimiters from `text` with the same nonce.
 */
export function wrapUntrusted(label: string, attributes: Record<string, string>, text: string, nonce: string): string {
	const attrs = Object.entries(attributes).map(([key, value]) => ` ${key}=${value.replace(/[^\w.-]/g, "")}`);
	return [`<<<${label}${attrs.join("")} nonce=${nonce}>>>`, text, `<<<END ${nonce}>>>`].join("\n");
}
