import type { ParsedEmail } from "@/lib/email/parse";

/**
 * What a delivered message's columns may hold, so one row stays well inside D1's 2 MB limit (Mailflare #217). The
 * full original stays in the raw MIME, and an HTML body over `BODY_OFFLOAD_BYTES` goes to the Mail store instead
 * (`planHtmlBodyOffload`); `htmlBodyBytes` only caps a body that stays in the row (before migration 0074).
 */
const INBOUND_LIMITS = {
	textBodyBytes: 450_000,
	htmlBodyBytes: 900_000,
	/** Message-ID, In-Reply-To and each References id; a longer one is dropped rather than cut. */
	messageIdChars: 512,
	referencesCount: 20,
	/** RFC 5322's line limit. */
	subjectChars: 998,
	addressChars: 998,
	addressListChars: 8_000,
} as const;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

/** `value` cut to at most `maxBytes` UTF-8 bytes, never inside a character. */
export function truncateUtf8(value: string, maxBytes: number): string {
	// A UTF-16 code unit is at most three UTF-8 bytes, so a short string always fits without encoding it.
	if (value.length * 3 <= maxBytes) return value;
	const bytes = encoder.encode(value);
	if (bytes.byteLength <= maxBytes) return value;
	// A cut inside a multi-byte sequence decodes to replacement characters at the end; drop them.
	return decoder.decode(bytes.subarray(0, maxBytes)).replace(/�+$/u, "");
}

/** A text body cut to what a row may hold. */
export function boundTextBody(text: string): string {
	return truncateUtf8(text, INBOUND_LIMITS.textBodyBytes);
}

/** `value` cut to at most `max` UTF-16 units, never between the halves of a surrogate pair. */
export function capChars(value: string | null, max: number): string | null {
	if (!value || value.length <= max) return value;
	const last = value.charCodeAt(max - 1);
	return value.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** A comma-joined address list cut to `max`, without a half address at the end that reply-all would write to. */
function capAddressList(value: string | null, max: number): string | null {
	const capped = capChars(value, max);
	if (!capped || capped === value) return capped;
	const lastSeparator = capped.lastIndexOf(",");
	return lastSeparator > 0 ? capped.slice(0, lastSeparator) : null;
}

function boundedId(value: string | null): string | null {
	return value && value.length <= INBOUND_LIMITS.messageIdChars ? value : null;
}

/**
 * A parsed inbound message whose stored fields fit `INBOUND_LIMITS`, so a hostile or merely odd message is stored
 * instead of failing its insert and being retried until the queue drops it. Ids too long to be real are dropped
 * (a cut id would thread wrongly), and so is an over-long From; the newest References are kept, since threading looks at the nearest parents.
 */
export function boundParsedEmail(
	parsed: ParsedEmail,
	options: {
		/** The HTML body can go to the Mail store (anything over `htmlBodyBytes` is far over the offload threshold). */
		offloadHtml?: boolean;
	} = {},
): ParsedEmail {
	return {
		...parsed,
		subject: capChars(parsed.subject, INBOUND_LIMITS.subjectChars),
		text: parsed.text === null ? null : boundTextBody(parsed.text),
		html:
			parsed.html === null || options.offloadHtml
				? parsed.html
				: truncateUtf8(parsed.html, INBOUND_LIMITS.htmlBodyBytes),
		messageId: boundedId(parsed.messageId),
		// Delivery falls back to the envelope sender: a cut From would name an address nobody sent from.
		fromAddr: parsed.fromAddr && parsed.fromAddr.length <= INBOUND_LIMITS.addressChars ? parsed.fromAddr : null,
		toAddr: capAddressList(parsed.toAddr, INBOUND_LIMITS.addressListChars),
		ccAddr: capAddressList(parsed.ccAddr, INBOUND_LIMITS.addressListChars),
		bccAddr: capAddressList(parsed.bccAddr, INBOUND_LIMITS.addressListChars),
		replyTo: capAddressList(parsed.replyTo, INBOUND_LIMITS.addressListChars),
		inReplyTo: boundedId(parsed.inReplyTo),
		references: parsed.references
			.filter((id) => id.length <= INBOUND_LIMITS.messageIdChars)
			.slice(-INBOUND_LIMITS.referencesCount),
	};
}
