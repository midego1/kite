"use client";

import { Reply } from "lucide-react";
import { useCompose } from "@/components/compose/compose-context";
import { useInlineComposerHost } from "@/components/compose/inline-composer-host";
import type { Message } from "@/hooks/types";
import type { ReplyableMessage } from "./types";
import { useMessageReply } from "./use-message-reply";

type QuickReplyProps = {
	/** The sender as the reader's header names them; mail you sent shows a plain "Reply…". */
	name: string;
	message: ReplyableMessage & Pick<Message, "id" | "mailboxId" | "subject" | "status" | "createdAt">;
	body?: { textBody?: string | null; htmlBody?: string | null } | null;
	ownAddress?: string | null;
	ownAddresses: string[];
};

/**
 * The reply box under an open message. It is a button shaped like a text field: pressing it starts the reply
 * in the composer, like Reply in the toolbar or `r`, so drafts, quoting and sending stay in one place.
 */
export function QuickReply({ name, message, body, ownAddress, ownAddresses }: QuickReplyProps) {
	const { reply, pending, error } = useMessageReply({
		mailboxId: message.mailboxId,
		senderAddress: message.fromAddr,
		direction: message.direction,
		subject: message.subject,
		bodyText: body?.textBody,
		bodyHtml: body?.htmlBody,
		ownAddress,
		ownAddresses,
		message,
		messageMeta: message,
	});
	const { collapsed, openDraftComposer } = useCompose();
	const host = useInlineComposerHost();
	// A reply collapsed with Esc under this message picks up where it was left.
	const resume = host && collapsed?.messageId === host.messageId ? collapsed.draftId : null;
	if (message.status === "draft") return null;
	return (
		<div className="shrink-0 border-t border-neutral-200 bg-white px-3 py-3 sm:px-6">
			<button
				type="button"
				onClick={() => (resume ? openDraftComposer(resume, { inlineFor: host?.messageId }) : void reply("reply"))}
				disabled={pending !== null}
				className="flex w-full items-center gap-2.5 rounded-xl border border-neutral-200 bg-white px-4 py-3 text-left text-sm text-neutral-500 transition-colors hover:border-blue-300 hover:text-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 disabled:opacity-60"
			>
				<Reply className="h-4 w-4 shrink-0" aria-hidden="true" />
				{pending ? (
					<span>Opening the reply…</span>
				) : message.direction === "inbound" ? (
					<span className="min-w-0 truncate">
						Reply to <bdi>{name}</bdi>…
					</span>
				) : (
					// Mail you sent: the reply goes to its recipients, not to you.
					<span>Reply…</span>
				)}
			</button>
			{error && (
				<p role="alert" className="mt-2 text-xs text-red-600">
					{error}
				</p>
			)}
		</div>
	);
}
