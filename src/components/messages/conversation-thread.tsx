"use client";

import { useState } from "react";
import { useSyncedState } from "@/hooks/use-synced-state";
import { formatUserDate } from "@/lib/time/utils";
import { ChevronsUpDown, Paperclip } from "lucide-react";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { QuotedEmailToggle } from "@/components/messages/quoted-email-toggle";
import { EmailHtmlFrame, RemoteImagesNotice } from "@/components/messages/email-html-frame";
import { useLoadRemoteImages } from "@/components/messages/use-load-remote-images";
import { runSingleMessageAction } from "@/components/message-actions/utils";
import { sanitizeEmailHtml } from "@/app/(dashboard)/inbox/[messageId]/email-html-sanitizer";
import { collapseQuotedEmailHtml } from "@/app/(dashboard)/inbox/[messageId]/quote-collapse-utils";
import {
	formatAttachmentSize,
	getMessageBodyDisplay,
	resolveInlineAttachmentUrls,
} from "@/app/(dashboard)/inbox/[messageId]/utils";
import { getAttachmentVisual } from "@/components/message-attachment-card-utils";

import { cn } from "@/lib/utils";
import type { ConversationMessageCardProps, ConversationThreadProps } from "./conversation-thread-types";
import { ThreadMessageActions } from "./thread-message-actions";
import {
	getConversationRecipients,
	getConversationSender,
	getConversationSenderEmail,
	partitionThread,
} from "./conversation-thread-utils";
import clsx from "clsx";
import { SuggestionCard } from "../agent/suggestion-card";

/**
 * The other messages in a conversation, ordered oldest to newest and collapsed
 * until opened. Readers can also expand the full visible portion at once.
 */
export function ConversationThread({
	currentMessageId,
	position,
	messages,
	mailboxId,
	currentAccountName,
	ownAddress,
	ownAddresses,
	latestMessagesFirst,
	expandedAll,
	onExpandedAllChange,
	showFullRecipientAddresses = false,
	threadId = null,
}: ConversationThreadProps) {
	const slice = partitionThread(messages, currentMessageId, position, latestMessagesFirst);
	// The reader mounts one thread above the message and one below; only the upper one carries the card.
	const card =
		position === (latestMessagesFirst ? "after" : "before") ? (
			<SuggestionCard mailboxId={mailboxId} messageId={currentMessageId} threadId={threadId} />
		) : null;
	if (slice.length === 0) return card;
	const firstMessage = slice[0];
	const lastMessage = slice.at(-1)!;
	const middleMessages = slice.slice(1, -1);
	const collapsed = !expandedAll && middleMessages.length > 0;
	const collapsedLabel = `${middleMessages.length} ${position === "before" ? "older" : "newer"} message${middleMessages.length === 1 ? "" : "s"}`;

	return (
		<>
			{card}
			<section
				aria-label={
					position === "before" ? "Earlier messages in this conversation" : "Later messages in this conversation"
				}
				className={cn(position === (latestMessagesFirst ? "before" : "after") ? "pb-6" : "")}
			>
				<ol>
					<li className={"border-t-0"}>
						<ConversationMessageCard
							message={firstMessage}
							mailboxId={mailboxId}
							currentAccountName={currentAccountName}
							ownAddress={ownAddress}
							ownAddresses={ownAddresses}
							showFullRecipientAddresses={showFullRecipientAddresses}
						/>
					</li>
					{collapsed ? (
						<li className="flex items-center justify-center gap-1 border-t border-neutral-200 py-3 text-center">
							<span className="flex flex-row items-center gap-2 px-6">
								<span className="text-sm font-medium text-neutral-600">{collapsedLabel}</span>
								<button
									type="button"
									onClick={() => onExpandedAllChange(true)}
									aria-label={`Expand ${collapsedLabel}`}
									title={`Expand ${collapsedLabel}`}
									className="inline-flex h-6 w-6 items-center justify-center rounded-full text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
								>
									<ChevronsUpDown className="h-4 w-4" />
								</button>
							</span>
						</li>
					) : (
						middleMessages.map((message) => (
							<li key={message.id}>
								<ConversationMessageCard
									message={message}
									mailboxId={mailboxId}
									currentAccountName={currentAccountName}
									ownAddress={ownAddress}
									ownAddresses={ownAddresses}
									showFullRecipientAddresses={showFullRecipientAddresses}
								/>
							</li>
						))
					)}
					{lastMessage.id !== firstMessage.id && (
						<li>
							<ConversationMessageCard
								message={lastMessage}
								mailboxId={mailboxId}
								currentAccountName={currentAccountName}
								ownAddress={ownAddress}
								ownAddresses={ownAddresses}
								showFullRecipientAddresses={showFullRecipientAddresses}
							/>
						</li>
					)}
				</ol>
			</section>
		</>
	);
}

/** An earlier message's attachment as the same chip as the open message's: its type, name and size. */
function ThreadAttachmentChip({
	messageId,
	attachment,
}: {
	messageId: string;
	attachment: ConversationMessageCardProps["message"]["attachments"][number];
}) {
	const visual = getAttachmentVisual(attachment);
	const Icon = visual.icon;
	const iconColor = visual.iconClassName
		.split(" ")
		.filter((name) => name.startsWith("text-"))
		.join(" ");
	return (
		<a
			href={`/api/messages/${messageId}/attachments/${attachment.id}`}
			title={`${attachment.filename} · ${visual.label}`}
			className="flex h-9 max-w-full items-center gap-2 rounded-lg bg-neutral-100 px-2.5 text-sm transition-colors hover:bg-neutral-200"
		>
			<Icon className={cn("h-4 w-4 shrink-0", iconColor)} aria-hidden="true" />
			<span className="min-w-0 max-w-48 truncate text-neutral-900">{attachment.filename}</span>
			<span className="shrink-0 text-neutral-500">{formatAttachmentSize(attachment.size)}</span>
		</a>
	);
}

export function ConversationMessageCard({
	message,
	mailboxId,
	currentAccountName,
	ownAddress,
	ownAddresses,
	defaultExpanded = false,
	showFullRecipientAddresses = false,
}: ConversationMessageCardProps) {
	const [locallyExpanded, setLocallyExpanded] = useState(defaultExpanded);
	const [locallyRead, setLocallyRead] = useSyncedState(message.read);
	const [alwaysLoadRemoteImages] = useLoadRemoteImages();
	const [remoteImagesShown, setRemoteImagesShown] = useState(false);
	const expanded = locallyExpanded;
	const sender = getConversationSender(message, currentAccountName);
	const senderEmail = getConversationSenderEmail(message);
	const recipients = getConversationRecipients(message, showFullRecipientAddresses ? "full" : "address");
	// const href = `${getMessageBackHref(message.direction, message.status)}/${message.id}`;
	const outbound = message.direction === "outbound";
	const attachments = message.attachments.filter((attachment) => attachment.disposition === "attachment");

	let body: { html: string | null; text: string; quotedHtml: string | null; blockedRemoteImages: number } | null = null;
	if (expanded) {
		const display = getMessageBodyDisplay(message.textBody, message.htmlBody, message.snippet);
		const imageOptions = {
			blockRemoteImages: !alwaysLoadRemoteImages && !remoteImagesShown,
			stats: { blockedRemoteImages: 0 },
			proxyRemoteImagesFor: message.id,
		};
		body = {
			html: collapseQuotedEmailHtml(
				sanitizeEmailHtml(resolveInlineAttachmentUrls(display.htmlBody, message.id, message.attachments), imageOptions),
			),
			text: display.latestContent,
			quotedHtml: collapseQuotedEmailHtml(
				sanitizeEmailHtml(
					resolveInlineAttachmentUrls(display.quotedHtml, message.id, message.attachments),
					imageOptions,
				),
				true,
			),
			blockedRemoteImages: imageOptions.stats.blockedRemoteImages,
		};
	}

	return (
		<article
			className={cn(
				// Each message is a section under a hairline, like the open one, as in Zero's reader.
				"border-t border-neutral-200 bg-white px-4 transition-colors sm:px-7",
				!expanded && "hover:bg-neutral-50",
			)}
		>
			<div className="w-full">
				<div className="flex w-full flex-wrap items-start gap-x-3 py-4">
					<button
						type="button"
						onClick={() => {
							const shouldExpand = !locallyExpanded;
							setLocallyExpanded(shouldExpand);
							if (!shouldExpand || locallyRead) return;
							setLocallyRead(true);
							void runSingleMessageAction(message.id, "read").catch(() => setLocallyRead(false));
						}}
						aria-expanded={expanded}
						className="flex min-w-0 flex-1 basis-40 items-center gap-3 text-left cursor-pointer"
					>
						<ContactAvatar
							mailboxId={mailboxId}
							address={message.fromAddr}
							name={sender}
							hasManagedAvatar={message.fromContactHasAvatar}
							managedAvatarUrl={outbound && mailboxId ? `/api/mailboxes/${mailboxId}/avatar` : undefined}
							className={expanded ? "mt-1" : ""}
						/>
						<span className="min-w-0 flex-1">
							<div className="flex flex-col">
								<span
									className={cn(
										"truncate text-sm font-semibold mt-1",
										locallyRead || outbound ? "text-neutral-900" : "font-semibold text-neutral-900",
									)}
								>
									{sender}
									{expanded && <span className="text-xs ml-1 opacity-50 font-normal">&lt;{senderEmail}&gt;</span>}
								</span>
								{expanded && recipients && (
									<span className="text-xs font-normal text-neutral-500">to {recipients}</span>
								)}
							</div>
							{!expanded && (
								<span
									className={clsx(!locallyRead ? "font-semibold" : "text-neutral-500", "block truncate text-[13px]")}
								>
									{message.snippet || "No preview"}
								</span>
							)}
						</span>
					</button>
					<span
						className={clsx(!locallyRead ? "font-semibold" : "", "flex shrink-0 items-center gap-2 text-xs mr-2 mt-2")}
					>
						{attachments.length > 0 && (
							<Paperclip className="h-3.5 w-3.5" aria-label={`${attachments.length} attachments`} />
						)}
						{formatUserDate(message.createdAt, {
							month: "short",
							day: "2-digit",
							year: "numeric",
							hour: "2-digit",
							minute: "2-digit",
						})}
					</span>
					<ThreadMessageActions
						message={message}
						mailboxId={mailboxId}
						ownAddress={ownAddress}
						ownAddresses={ownAddresses}
						starOnly={!expanded}
					/>
				</div>
				{expanded && body && (
					<div className="pb-6 pt-1">
						{body.blockedRemoteImages > 0 && <RemoteImagesNotice onShow={() => setRemoteImagesShown(true)} />}
						{body.html ? (
							<EmailHtmlFrame html={body.html} className="email-body max-w-none" />
						) : (
							<pre className="whitespace-pre-wrap font-sans text-sm text-neutral-900">{body.text}</pre>
						)}
						{body.quotedHtml && <QuotedEmailToggle html={body.quotedHtml} />}
						{attachments.length > 0 && (
							<ul className="mt-4 flex flex-wrap gap-2">
								{attachments.map((attachment) => (
									<li key={attachment.id}>
										<ThreadAttachmentChip messageId={message.id} attachment={attachment} />
									</li>
								))}
							</ul>
						)}
					</div>
				)}
			</div>
		</article>
	);
}
