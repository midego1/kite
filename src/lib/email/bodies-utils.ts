import { htmlToReadableText } from "./reply-content-utils";

/** HTML bodies larger than this many UTF-8 bytes are written to the Mail store instead of D1 (imported mail). */
export const BODY_OFFLOAD_BYTES = 16 * 1024;

const BODY_KEY_PREFIX = "bodies/";

/** The Mail store key of a message's offloaded HTML body. One per message, so deleting a message knows it. */
export function htmlBodyObjectKey(messageId: string): string {
	return `${BODY_KEY_PREFIX}${messageId}.html`;
}

/**
 * Whether `key` is the body key of `messageId`. A key is only ever this one, so a stored value that names any
 * other object (a hand-edited or foreign backup) is never read as a message body.
 */
export function isHtmlBodyObjectKey(messageId: string, key: string | null | undefined): boolean {
	return !!key && key === htmlBodyObjectKey(messageId);
}

/** Whether an HTML body is over `BODY_OFFLOAD_BYTES`, without encoding it when its length already decides. */
export function exceedsBodyOffloadBytes(html: string | null | undefined, limit = BODY_OFFLOAD_BYTES): boolean {
	if (!html) return false;
	// A UTF-16 code unit is one to three UTF-8 bytes.
	if (html.length > limit) return true;
	if (html.length * 3 <= limit) return false;
	return new TextEncoder().encode(html).byteLength > limit;
}

export type HtmlBodyOffload = {
	key: string;
	html: string;
	/** UTF-8 bytes of the text part and the HTML, as an inline row would measure them (`messages.body_size`). */
	bodySize: number;
	/** What the row keeps instead: the text part, or `derivedTextBody(html)` when there is none. */
	textBody: string;
};

/**
 * The text body an offloaded message without a text part keeps, so search still finds it. Readers get the
 * message back without it (`withoutDerivedText`), exactly as it was before the offload.
 */
export function derivedTextBody(html: string): string {
	return htmlToReadableText(html);
}

/** A row whose offloaded HTML was read back, with a derived text body set back to null. */
export function withoutDerivedText<T extends { textBody?: string | null }>(row: T, html: string): T {
	return row.textBody && row.textBody === derivedTextBody(html) ? { ...row, textBody: null } : row;
}

/**
 * How a parsed message's bodies are stored when its HTML is offloaded, or null when it stays in the row. The
 * row keeps a text body either way, because search (FTS5 indexes `text_body`), snippets, the reader's plain
 * fallback and automatic reading all read it from D1.
 */
export function planHtmlBodyOffload(
	messageId: string,
	body: { text: string | null | undefined; html: string | null | undefined },
	limit = BODY_OFFLOAD_BYTES,
): HtmlBodyOffload | null {
	const html = body.html;
	if (!html || !exceedsBodyOffloadBytes(html, limit)) return null;
	const encoder = new TextEncoder();
	return {
		key: htmlBodyObjectKey(messageId),
		html,
		bodySize: encoder.encode(body.text ?? "").byteLength + encoder.encode(html).byteLength,
		textBody: body.text || derivedTextBody(html),
	};
}
