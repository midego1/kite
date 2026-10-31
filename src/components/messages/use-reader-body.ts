"use client";

import { useMemo } from "react";
import { emptyEmailColours } from "@/components/messages/email-colour-utils";
import type { EmailColourFacts } from "@/components/messages/email-html-frame-types";
import { sanitizeEmailHtml } from "@/app/(dashboard)/inbox/[messageId]/email-html-sanitizer";
import { collapseQuotedEmailHtml } from "@/app/(dashboard)/inbox/[messageId]/quote-collapse-utils";
import { getMessageBodyDisplay, resolveInlineAttachmentUrls } from "@/app/(dashboard)/inbox/[messageId]/utils";
import type { MessageAttachment, MessageBodyDisplay } from "@/app/(dashboard)/inbox/[messageId]/types";
import { inlineAttachmentKey, parseInlineAttachmentKey } from "./reader-body-utils";

export type ReaderBodyInput = {
	messageId: string;
	textBody: string | null | undefined;
	htmlBody: string | null | undefined;
	snippet: string | null | undefined;
	ownAddress?: string;
	attachments: MessageAttachment[];
	blockRemoteImages: boolean;
	dropFontFamily: boolean;
};

export type ReaderBody = {
	display: MessageBodyDisplay;
	html: string | null;
	colours: EmailColourFacts;
	quotedHtml: string | null;
	quotedColours: EmailColourFacts;
	blockedRemoteImages: number;
};

/**
 * A message's body as the reader shows it: split from its quoted history, sanitized and folded. Sanitizing parses
 * and walks the whole document, so it runs once per message and setting instead of on every render: the reader
 * renders many times while it starts (session, mailboxes, thread, summary, preferences), and a large newsletter
 * would otherwise block the main thread each time. Attachments count by their inline ids only, so a refetch that
 * returns the same list does not sanitize again.
 */
export function useReaderBody(input: ReaderBodyInput | null): ReaderBody | null {
	const messageId = input?.messageId ?? null;
	const textBody = input?.textBody;
	const htmlBody = input?.htmlBody;
	const snippet = input?.snippet;
	const ownAddress = input?.ownAddress;
	const blockRemoteImages = input?.blockRemoteImages ?? true;
	const dropFontFamily = input?.dropFontFamily ?? false;
	const attachmentKey = inlineAttachmentKey(input?.attachments ?? []);
	return useMemo(() => {
		if (messageId === null) return null;
		const attachments = parseInlineAttachmentKey(attachmentKey);
		const display = getMessageBodyDisplay(textBody, htmlBody, snippet, ownAddress);
		const stats = { blockedRemoteImages: 0 };
		const imageOptions = {
			blockRemoteImages,
			stats,
			proxyRemoteImagesFor: messageId,
			linkify: true,
			dropFontFamily,
		};
		const colours = emptyEmailColours();
		const quotedColours = emptyEmailColours();
		const html = collapseQuotedEmailHtml(
			sanitizeEmailHtml(resolveInlineAttachmentUrls(display.htmlBody, messageId, attachments), {
				...imageOptions,
				colours,
			}),
		);
		const quotedHtml = collapseQuotedEmailHtml(
			sanitizeEmailHtml(resolveInlineAttachmentUrls(display.quotedHtml, messageId, attachments), {
				...imageOptions,
				colours: quotedColours,
			}),
			true,
		);
		return { display, html, colours, quotedHtml, quotedColours, blockedRemoteImages: stats.blockedRemoteImages };
	}, [messageId, textBody, htmlBody, snippet, ownAddress, attachmentKey, blockRemoteImages, dropFontFamily]);
}
