"use client";

import { useCallback, useMemo, useState } from "react";
import { useCompose, type InlineDraftKind } from "@/components/compose/compose-context";
import { requestConfirmation } from "@/components/ui/confirm-dialog-utils";
import { useInlineComposerHost } from "@/components/compose/inline-composer-host";
import { useIsMobile } from "@/components/sidebar-mobile-utils";
import type { MessageActionsProps, ReplyMode } from "./types";
import {
	createForwardDraft,
	createReplyDraft,
	getReplyRecipients,
	getReplyThreading,
	hasAdditionalRecipients,
} from "./utils";

export type MessageReplyInput = Pick<
	MessageActionsProps,
	| "mailboxId"
	| "senderAddress"
	| "direction"
	| "subject"
	| "bodyText"
	| "bodyHtml"
	| "ownAddress"
	| "ownAddresses"
	| "message"
	| "messageMeta"
>;

/**
 * Reply, reply all and forward for one message: each creates a draft and opens it in the composer. Shared by
 * the reader toolbar, its keyboard shortcuts and the quick-reply box under the message.
 */
export function useMessageReply({
	mailboxId,
	senderAddress,
	direction,
	subject,
	bodyText,
	bodyHtml,
	ownAddress,
	ownAddresses = [],
	message,
	messageMeta,
}: MessageReplyInput) {
	const { openDraftComposer, open, placement, collapsed } = useCompose();
	// In a reader on a wider screen replies open docked under the message; phones keep the full-screen composer.
	const inlineHost = useInlineComposerHost();
	const isMobile = useIsMobile();
	const inlineFor = inlineHost && !isMobile ? inlineHost.messageId : null;
	const [pending, setPending] = useState<ReplyMode | "forward" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const replyable = useMemo(
		() =>
			message ?? {
				direction,
				fromAddr: senderAddress,
				toAddr: "",
				ccAddr: null,
				providerMessageId: null,
				references: null,
				threadId: null,
			},
		[message, direction, senderAddress],
	);
	const canReplyAll = hasAdditionalRecipients(replyable, ownAddresses);
	const sentAt = messageMeta?.createdAt;

	const source = messageMeta?.id ?? null;
	/** The draft of this kind for this message that was collapsed in this reader, if any. */
	const resumable = useCallback(
		(kind: InlineDraftKind) =>
			inlineFor && collapsed?.messageId === inlineFor && collapsed.source === source && collapsed.kind === kind
				? collapsed.draftId
				: null,
		[inlineFor, collapsed, source],
	);
	/** Docking a reply closes an open floating composer; its draft stays in Drafts, but ask first. */
	const mayReplaceComposer = useCallback(
		() =>
			!inlineFor || !open || placement !== "popup"
				? Promise.resolve(true)
				: requestConfirmation({
						title: "Close the open message?",
						description: "The message you are writing is saved in Drafts.",
						confirmLabel: "Close and reply",
					}),
		[inlineFor, open, placement],
	);

	const reply = useCallback(
		async (mode: ReplyMode) => {
			const resume = resumable(mode);
			if (!(await mayReplaceComposer())) return;
			if (resume) {
				openDraftComposer(resume, { inlineFor, kind: mode, source });
				return;
			}
			setPending(mode);
			setError(null);
			try {
				const draftId = await createReplyDraft({
					mailboxId,
					senderAddress,
					ownAddress,
					subject,
					bodyText,
					bodyHtml,
					sentAt,
					recipients: getReplyRecipients(replyable, ownAddresses, mode),
					threading: getReplyThreading(replyable),
				});
				openDraftComposer(draftId, { inlineFor, kind: mode, source });
			} catch (replyError) {
				setError(replyError instanceof Error ? replyError.message : "Could not start reply");
			} finally {
				setPending(null);
			}
		},
		[
			mailboxId,
			senderAddress,
			ownAddress,
			subject,
			bodyText,
			bodyHtml,
			sentAt,
			replyable,
			ownAddresses,
			openDraftComposer,
			inlineFor,
			source,
			resumable,
			mayReplaceComposer,
		],
	);

	const canForward = !!message && !!messageMeta;
	const forward = useCallback(async () => {
		if (!message || !messageMeta) return;
		const resume = resumable("forward");
		if (!(await mayReplaceComposer())) return;
		if (resume) {
			openDraftComposer(resume, { inlineFor, kind: "forward", source });
			return;
		}
		setPending("forward");
		setError(null);
		try {
			const draftId = await createForwardDraft({
				mailboxId,
				ownAddress,
				message: { ...message, ...messageMeta },
				bodyText,
				bodyHtml,
			});
			openDraftComposer(draftId, { inlineFor, kind: "forward", source });
		} catch (forwardError) {
			setError(forwardError instanceof Error ? forwardError.message : "Could not start forward");
		} finally {
			setPending(null);
		}
	}, [
		message,
		messageMeta,
		mailboxId,
		ownAddress,
		bodyText,
		bodyHtml,
		openDraftComposer,
		inlineFor,
		source,
		resumable,
		mayReplaceComposer,
	]);

	return { reply, forward, canReplyAll, canForward, pending, error };
}
