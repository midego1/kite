import PostalMime, { type PostalMimeError } from "postal-mime";
import { collapseFoldingSpace, formatPostalAddress, formatPostalAddressList } from "@/lib/email/address";
import { normalizeMessageId, parseMessageIdList } from "@/lib/email/threading";
import { normalizeAttachmentContent } from "@/lib/email/attachment-content-utils";
import { getLatestEmailContent, htmlToReadableText } from "@/lib/email/reply-content-utils";
import { sanitizeStoredEmailHtml } from "@/lib/email/stored-html-utils";
import {
	cutBodies,
	limitBodyConversion,
	limitDecodedText,
	TEXT_CUT_NOTE,
	withHtmlCutNote,
} from "@/lib/email/mime-body-utils";
import { MIME_LIMITS, mimePreflightReason } from "@/lib/email/mime-preflight";
import type { AttachmentContent } from "@/lib/email/attachment-types";

export type ParsedEmail = {
	subject: string | null;
	text: string | null;
	html: string | null;
	messageId: string | null;
	fromAddr: string | null;
	/** Full To header, comma-joined. */
	toAddr: string | null;
	/** Full Cc header, comma-joined. */
	ccAddr: string | null;
	/** Full Bcc header, comma-joined. Only present on mail composed locally, never on delivered mail. */
	bccAddr: string | null;
	/** Full Reply-To header, comma-joined. */
	replyTo: string | null;
	inReplyTo: string | null;
	references: string[];
	date: Date | null;
	attachments: AttachmentContent[];
	/**
	 * Whether a body was cut to `MAX_DECODED_TEXT_BYTES` (`mime-body-utils.ts`) and ends with the note: fine to store
	 * beside the raw message, which keeps the rest, but not to send on as the message.
	 */
	bodyCut: boolean;
};

/** postal-mime's own caps, reported like the preflight's. */
const LIMIT_ERROR_CODES = new Set(["EMAXNESTINGDEPTH", "EMAXHEADERSIZE", "EMAXPARTCOUNT"]);

/**
 * A message that can never be parsed within `MIME_LIMITS`. Deterministic: retrying only repeats the work, so callers
 * refuse or drop the message instead.
 */
export class MimeLimitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MimeLimitError";
	}
}

/**
 * Parses a raw message within `MIME_LIMITS`, so every caller (inbound intake and delivery, imports, JMAP
 * `Email/import`, automatic reading) gets the structural preflight before anything is decoded. Throws
 * `MimeLimitError` for a message over the limits, including postal-mime's own nesting and header caps.
 */
export async function parseRawMime(raw: ArrayBuffer): Promise<ParsedEmail> {
	const limitReason = mimePreflightReason(raw);
	if (limitReason) throw new MimeLimitError(limitReason);
	let email: Awaited<ReturnType<typeof PostalMime.parse>>;
	let cut: ReturnType<typeof cutBodies>;
	try {
		// forceRfc822Attachments keeps an attached message one leaf part, which is what the preflight models.
		const parser = new PostalMime({
			maxNestingDepth: MIME_LIMITS.maxNestingDepth,
			maxHeadersSize: MIME_LIMITS.maxTotalHeaderBytes,
			maxPartCount: MIME_LIMITS.maxParts,
			forceRfc822Attachments: true,
		});
		const converted = limitBodyConversion(parser);
		const decoded = limitDecodedText(parser);
		email = await parser.parse(raw);
		cut = cutBodies(decoded, converted);
	} catch (error) {
		if (LIMIT_ERROR_CODES.has((error as PostalMimeError).code)) {
			const { message } = error as PostalMimeError;
			throw new MimeLimitError(`Message rejected: ${message.charAt(0).toLowerCase()}${message.slice(1)}.`);
		}
		throw error;
	}
	const date = email.date ? new Date(email.date) : null;
	const text = email.text ?? null;
	const html = sanitizeStoredEmailHtml(email.html);
	return {
		subject: email.subject === undefined ? null : collapseFoldingSpace(email.subject),
		// A body over `MAX_DECODED_TEXT_BYTES` was cut before it was decoded; the raw message still holds all of it.
		text: text !== null && cut.plain ? `${text}${TEXT_CUT_NOTE}` : text,
		html: html !== null && cut.html ? withHtmlCutNote(html) : html,
		messageId: email.messageId ?? null,
		fromAddr: formatPostalAddress(email.from, null),
		toAddr: formatPostalAddressList(email.to, null),
		ccAddr: formatPostalAddressList(email.cc, null),
		bccAddr: formatPostalAddressList(email.bcc, null),
		replyTo: formatPostalAddressList(email.replyTo, null),
		inReplyTo: normalizeMessageId(email.inReplyTo),
		references: parseMessageIdList(email.references),
		date: date && !Number.isNaN(date.getTime()) ? date : null,
		attachments: email.attachments.map((attachment, index) => ({
			filename: collapseFoldingSpace(attachment.filename ?? `attachment-${index + 1}`),
			type: attachment.mimeType || "application/octet-stream",
			content: normalizeAttachmentContent(attachment.content, attachment.encoding),
			disposition: attachment.disposition === "inline" ? "inline" : "attachment",
			contentId: attachment.contentId ?? null,
		})),
		bodyCut: cut.plain || cut.html,
	};
}

export function buildSnippet(text: string | null, html: string | null, max = 200): string {
	const source = getLatestEmailContent(text?.trim() || htmlToReadableText(html));
	let snippet = "";
	// Word by word up to `max`: a replace over the whole body keeps a record of every run of whitespace in it.
	for (const [word] of source.matchAll(/\S+/g)) {
		snippet += snippet ? ` ${word}` : word;
		if (snippet.length >= max) break;
	}
	return snippet.slice(0, max);
}
