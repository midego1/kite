import type { MessageAttachment } from "@/app/(dashboard)/inbox/[messageId]/types";

export type InlineAttachmentRef = Pick<MessageAttachment, "id" | "contentId">;

/**
 * The part of a message's attachments that changes its rendered body: the ids of the parts its HTML names by
 * `cid:`. Equal lists give equal keys, so a refetched copy of the same attachments keeps the body memoized.
 */
export function inlineAttachmentKey(attachments: InlineAttachmentRef[]): string {
	const inline = attachments.filter((attachment) => attachment.contentId);
	if (!inline.length) return "";
	return JSON.stringify(inline.map((attachment) => [attachment.id, attachment.contentId]));
}

/** The inline attachments `inlineAttachmentKey` describes, enough for `resolveInlineAttachmentUrls`. */
export function parseInlineAttachmentKey(key: string): InlineAttachmentRef[] {
	if (!key) return [];
	return (JSON.parse(key) as [string, string][]).map(([id, contentId]) => ({ id, contentId }));
}
