import { hasDraftContent } from "./draft-autosave-utils";
import { recipientsToHeader } from "./recipient-utils";
import { htmlToPlainText, joinQuotedHtml } from "./rich-text-utils";
import type { ComposeAttachment, ComposeDraftSnapshot, ComposeThreading } from "./types";

/** What the autosave stores for the composer's current state, or null while there is nothing to save. */
export function buildDraftSnapshot(input: {
	mailboxId: string | undefined;
	signature: string | null | undefined;
	from: string;
	loadingDraft: boolean;
	to: string[];
	cc: string[];
	bcc: string[];
	subject: string;
	html: string;
	quotedHtml: string | null;
	threading: ComposeThreading | null;
	attachments: ComposeAttachment[];
	aiAssisted: boolean;
	agentRevision: number | null;
}): ComposeDraftSnapshot | null {
	const { to, cc, bcc, subject, html, quotedHtml, threading, attachments } = input;
	const content = {
		recipients: to.length + cc.length + bcc.length,
		subject,
		quotedHtml,
		attachments: attachments.length,
		bodyText: htmlToPlainText(html),
		signature: input.signature,
	};
	if (!input.from || input.loadingDraft || !hasDraftContent(content)) return null;
	const fullHtml = joinQuotedHtml(html, quotedHtml);
	return {
		payload: {
			mailboxId: input.mailboxId,
			from: input.from,
			to: recipientsToHeader(to),
			cc: recipientsToHeader(cc),
			bcc: recipientsToHeader(bcc),
			subject,
			html: fullHtml,
			text: htmlToPlainText(fullHtml),
			inReplyTo: threading?.inReplyTo ?? null,
			references: threading?.references ?? null,
			threadId: threading?.threadId ?? null,
			aiAssisted: input.aiAssisted,
		},
		attachments,
		storeAttachments: input.agentRevision === null,
	};
}
