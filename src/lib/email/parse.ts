import PostalMime from "postal-mime";
import { formatPostalAddress, formatPostalAddressList } from "@/lib/email/address";
import { normalizeMessageId, parseMessageIdList } from "@/lib/email/threading";
import { normalizeAttachmentContent } from "@/lib/email/attachments";
import { getLatestEmailContent, htmlToReadableText } from "@/lib/email/reply-content-utils";
import { sanitizeStoredEmailHtml } from "@/lib/email/stored-html-utils";
import { MIME_LIMITS, mimePreflightReason } from "@/lib/email/mime-preflight";
import { decodeFlowedText } from "@/lib/email/flowed-text-utils";
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
};

/**
 * postal-mime 2.7 unfolds format=flowed text in quadratic time (a 2.4 MB message of 39,000 flowed lines took about
 * 25 s); every parser's nodes share one prototype, so its method is replaced once with a linear one that returns the
 * same text. postal-mime 4.x unfolds in linear time itself: drop this when upgrading.
 */
const mimeNodePrototype = Object.getPrototypeOf((new PostalMime() as unknown as { root: object }).root) as {
	decodeFlowedText?: (text: string, delSp: boolean) => string;
};
if (typeof mimeNodePrototype.decodeFlowedText === "function") mimeNodePrototype.decodeFlowedText = decodeFlowedText;

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
	try {
		// forceRfc822Attachments keeps postal-mime from parsing an inline message/rfc822 again with fresh options,
		// which would restart the nesting count at every level.
		email = await PostalMime.parse(raw, {
			maxNestingDepth: MIME_LIMITS.maxNestingDepth,
			maxHeadersSize: MIME_LIMITS.maxHeaderBytes,
			forceRfc822Attachments: true,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		if (/^Maximum (MIME nesting depth|header size)/.test(message))
			throw new MimeLimitError(`Message rejected: ${message.charAt(0).toLowerCase()}${message.slice(1)}.`);
		throw error;
	}
	const date = email.date ? new Date(email.date) : null;
	return {
		subject: email.subject ?? null,
		text: email.text ?? null,
		html: sanitizeStoredEmailHtml(email.html),
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
			filename: attachment.filename ?? `attachment-${index + 1}`,
			type: attachment.mimeType || "application/octet-stream",
			content: normalizeAttachmentContent(attachment.content, attachment.encoding),
			disposition: attachment.disposition === "inline" ? "inline" : "attachment",
			contentId: attachment.contentId ?? null,
		})),
	};
}

export function buildSnippet(text: string | null, html: string | null, max = 200): string {
	const source = getLatestEmailContent(text?.trim() || htmlToReadableText(html));
	return source.replace(/\s+/g, " ").trim().slice(0, max);
}
