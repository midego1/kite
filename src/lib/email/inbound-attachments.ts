import { MAX_ATTACHMENT_COUNT, MAX_ATTACHMENT_SIZE, MAX_TOTAL_ATTACHMENT_SIZE } from "@/lib/email/attachments";
import { MimeLimitError, parseRawMime } from "@/lib/email/parse";
import type { AttachmentContent } from "@/lib/email/attachment-types";

export function inboundAttachmentLimitReason(attachments: AttachmentContent[]): string | null {
	if (attachments.length > MAX_ATTACHMENT_COUNT) {
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

/** Answered when a message cannot be parsed at all; delivery would fail on it the same way every time. */
export const UNPARSEABLE_MESSAGE_REASON = "Message rejected: the message could not be parsed.";

/**
 * Why intake refuses a raw message (its limits or its structure), or null. Every intake path runs this before the
 * message is stored, so mail that can never be delivered is refused at the edge instead of retried by the queue.
 */
export async function inboundAttachmentLimitReasonFromRaw(raw: ArrayBuffer): Promise<string | null> {
	try {
		const parsed = await parseRawMime(raw);
		return inboundAttachmentLimitReason(parsed.attachments);
	} catch (error) {
		if (error instanceof MimeLimitError) return error.message;
		console.warn("Inbound MIME parse failed", error instanceof Error ? error.message : error);
		return UNPARSEABLE_MESSAGE_REASON;
	}
}
