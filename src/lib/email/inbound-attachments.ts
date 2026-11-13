import { MAX_ATTACHMENT_COUNT, MAX_ATTACHMENT_SIZE, MAX_TOTAL_ATTACHMENT_SIZE } from "@/lib/email/attachments";
import { MimeLimitError, parseRawMime } from "@/lib/email/parse";
import type { AttachmentContent } from "@/lib/email/attachment-types";

/**
 * Why a message's attachments exceed what Kite receives, or null. Attached messages (`message/rfc822`: a forward as
 * attachment, every post of a mailing-list digest) are not files someone attached and do not count toward the number
 * of attachments; their size counts like any other. The MIME preflight bounds how many parts a message can have.
 */
export function inboundAttachmentLimitReason(attachments: AttachmentContent[]): string | null {
	const files = attachments.filter((attachment) => attachment.type.toLowerCase() !== "message/rfc822").length;
	if (files > MAX_ATTACHMENT_COUNT) {
		return `Message rejected: more than ${MAX_ATTACHMENT_COUNT} attachments. Send fewer files or a download link.`;
	}
	let totalSize = 0;
	for (const attachment of attachments) {
		const size = attachment.content.byteLength;
		if (size > MAX_ATTACHMENT_SIZE) {
			return "Message rejected: an attachment exceeds 25 MB. Send a download link instead.";
		}
		totalSize += size;
		if (totalSize > MAX_TOTAL_ATTACHMENT_SIZE) {
			return "Message rejected: attachments exceed 25 MB in total. Send a download link instead.";
		}
	}
	return null;
}

/** The refusal for a message the parser cannot read; the same bytes fail the same way on every retry. */
export const UNREADABLE_MIME_REASON = "Message rejected: the message could not be read as MIME.";

/**
 * Why intake refuses a raw message (its limits or its MIME structure), or null. Every intake path runs this before the
 * message is stored, so mail that can never be delivered is refused at the edge. A parse failure is a property of the
 * bytes and would repeat on every retry, so it is refused too (`UNREADABLE_MIME_REASON`); only a `RangeError` (out of
 * memory, which a fresh isolate may not hit) is thrown, so the sender tries again later (the SMTP listener answers 451).
 */
export async function inboundAttachmentLimitReasonFromRaw(raw: ArrayBuffer): Promise<string | null> {
	try {
		const parsed = await parseRawMime(raw);
		return inboundAttachmentLimitReason(parsed.attachments);
	} catch (error) {
		if (error instanceof MimeLimitError) return error.message;
		if (error instanceof RangeError) throw error;
		console.warn("Inbound message could not be parsed", error instanceof Error ? error.name : "unknown error");
		return UNREADABLE_MIME_REASON;
	}
}
