"use client";

import { useCallback, useMemo, useState } from "react";
import { useCompose } from "@/components/compose/compose-context";
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
	const { openDraftComposer } = useCompose();
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

	const reply = useCallback(
		async (mode: ReplyMode) => {
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
				openDraftComposer(draftId);
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
		],
	);

	const canForward = !!message && !!messageMeta;
	const forward = useCallback(async () => {
		if (!message || !messageMeta) return;
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
			openDraftComposer(draftId);
		} catch (forwardError) {
			setError(forwardError instanceof Error ? forwardError.message : "Could not start forward");
		} finally {
			setPending(null);
		}
	}, [message, messageMeta, mailboxId, ownAddress, bodyText, bodyHtml, openDraftComposer]);

	return { reply, forward, canReplyAll, canForward, pending, error };
}
