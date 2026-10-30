"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Cloud, ExternalLink } from "lucide-react";
import { formatUserDate } from "@/lib/time/utils";
import { useKeyChanged } from "@/hooks/use-synced-state";
import { MarkAsRead } from "@/components/mark-read";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { ContactCard } from "@/components/contacts/contact-card";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { MessageActions } from "@/components/message-actions/message-actions";
import { MessageAttachmentViewer } from "@/components/message-attachment-viewer";
import { MessageAttachmentCard } from "@/components/message-attachment-card";
import { MessageDetailSkeleton } from "@/components/page-skeletons";
import { usePageLoading } from "@/components/page-loading";
import { PreviousMessage } from "@/components/previous-message";
import { ConversationThread } from "@/components/messages/conversation-thread";
import { MessageDetailNavigation } from "@/components/messages/message-detail-navigation";
import { QuickReply } from "@/components/message-actions/quick-reply";
import { AssistantButton } from "@/components/agent/assistant-button";
import { MessageReadingHeaderButton } from "@/components/messages/message-reading-header-button";
import { QuotedEmailToggle } from "@/components/messages/quoted-email-toggle";
import { EmailHtmlFrame, RemoteImagesNotice } from "@/components/messages/email-html-frame";
import { LinkifiedText } from "@/components/messages/linkified-text";
import { useLoadRemoteImages } from "@/components/messages/use-load-remote-images";
import { useReaderFont } from "@/components/messages/use-reader-font";
import { ThreadMessageActions } from "@/components/messages/thread-message-actions";
import { useMessageThread } from "@/components/messages/use-message-thread";
import { useLatestMessagesFirst } from "@/components/messages/use-latest-messages-first";
import { useMessageListVisibility } from "@/components/messages/message-list-visibility";
import { getEmailAddress, getEmailDisplayName, splitEmailAddressList } from "@/lib/email/address";
import {
	getConversationSender,
	getThreadDateRange,
	getThreadParticipants,
} from "@/components/messages/conversation-thread-utils";
import { ReaderThreadHeader } from "@/components/messages/reader-thread-header";
import { MessageReplyButtons } from "@/components/message-actions/message-reply-buttons";
import { InlineComposerHost, InlineReplyComposer } from "@/components/compose/inline-reply-composer";
import { extractOneTimeCode } from "@/lib/email/one-time-code-utils";
import { OneTimeCodeChip } from "@/components/messages/one-time-code-chip";
import { SendStateBanner } from "@/components/messages/send-state-banner";
import { ScreenerBanner } from "@/components/screener/screener-banner";
import { RecipientList } from "@/components/messages/recipient-list";
import { useShowFullRecipientAddresses } from "@/components/messages/use-show-full-recipient-addresses";
import type { MessageAttachment, MessageDetailResponse } from "./types";
import {
	fetchMessageDetail,
	fetchMessageMetadata,
	getCachedMessageDetailForDisplay,
	getMessageBodyDisplay,
	getMessageHeaderParties,
	getOwnAddressForMessage,
	resolveInlineAttachmentUrls,
} from "./utils";
import { extractCloudAttachments } from "./cloud-attachment-utils";
import { sanitizeEmailHtml } from "./email-html-sanitizer";
import { collapseQuotedEmailHtml } from "./quote-collapse-utils";
import { useAssistantOpen } from "@/components/agent/assistant-open-state";
import { useMessageContentScroll } from "./use-message-content-scroll";
import { SummarizeButton, ThreadSummaryCard } from "@/components/messages/thread-summary-card";
import { useThreadSummary } from "@/components/messages/use-thread-summary";
import { showsCurrentSummary } from "@/components/messages/thread-summary-utils";
import { mailboxSendableAddresses } from "@/components/compose/sender-options-utils";

export default function MessageDetailPage() {
	const params = useParams<{ messageId: string }>();
	const { selectedMailbox, mailboxes } = useSelectedMailbox();
	const messageId = params.messageId;
	const [data, setData] = useState<MessageDetailResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [previewAttachment, setPreviewAttachment] = useState<MessageAttachment | null>(null);
	const [threadExpanded, setThreadExpanded] = useState(false);
	const [alwaysLoadRemoteImages] = useLoadRemoteImages();
	const readerFont = useReaderFont();
	const [remoteImagesShownFor, setRemoteImagesShownFor] = useState<string | null>(null);
	const [latestMessagesFirst] = useLatestMessagesFirst();
	const { enabled: showFullRecipientAddresses } = useShowFullRecipientAddresses();
	const { visible: messageListVisible } = useMessageListVisibility();
	usePageLoading(loading);
	const thread = useMessageThread(messageId, data?.message?.threadId);
	const assistantVisible = useAssistantOpen();
	const isAnyPanelVisible = messageListVisible || assistantVisible;
	const { scrollRef, handleScroll } = useMessageContentScroll(messageId, loading);
	const summary = useThreadSummary(messageId, "thread");
	const hideTriageSummary = showsCurrentSummary(summary.state, summary.hidden);

	useEffect(() => {
		let cancelled = false;

		async function loadMessage() {
			const cachedData = getCachedMessageDetailForDisplay(messageId);
			if (cachedData?.message && cachedData.body) {
				setData(cachedData);
				setLoading(false);
				if (cachedData.attachments !== undefined) return;
				try {
					const metadata = await fetchMessageMetadata(messageId);
					if (!cancelled) setData((current) => (current ? { ...current, ...metadata } : current));
				} catch {
					// The message body remains usable if supplemental metadata is unavailable.
				}
				return;
			}
			setLoading(true);
			const nextData = await fetchMessageDetail(messageId);
			if (!cancelled) {
				setData(nextData);
				setLoading(false);
			}
		}

		void loadMessage();
		return () => {
			cancelled = true;
		};
	}, [messageId]);

	if (useKeyChanged(messageId)) setThreadExpanded(false);

	if (loading) {
		return <MessageDetailSkeleton />;
	}

	if (!data?.message) {
		return <p className="px-6 py-4 text-sm text-neutral-500">{data?.error ?? "Message not found"}</p>;
	}

	const { message, body, attachments = [] } = data;
	const currentThreadMessage = {
		...message,
		textBody: body?.textBody ?? null,
		htmlBody: body?.htmlBody ?? null,
		attachments,
	};
	const messageMailbox = mailboxes.find((mailbox) => mailbox.id === message.mailboxId) ?? selectedMailbox;
	const currentAccountName = messageMailbox?.displayName ?? messageMailbox?.localPart;
	const { fromName, fromAddress } = getMessageHeaderParties(message, currentAccountName);
	// Connected addresses count as the mailbox's own, so a reply goes out from the address the mail came to.
	const ownAddresses = messageMailbox ? mailboxSendableAddresses(messageMailbox) : [];
	const ownAddress = getOwnAddressForMessage(message, ownAddresses);
	const toEntries = splitEmailAddressList(message.toAddr);
	const ccEntries = splitEmailAddressList(message.ccAddr);
	const bccEntries = splitEmailAddressList(message.bccAddr);
	// The thread may or may not list the open message itself.
	const threadSize = new Set([message.id, ...thread.messages.map((threadMessage) => threadMessage.id)]).size;
	const bodyDisplay = getMessageBodyDisplay(body?.textBody, body?.htmlBody, message.snippet, ownAddress);
	const imageOptions = {
		blockRemoteImages: !alwaysLoadRemoteImages && remoteImagesShownFor !== message.id,
		stats: { blockedRemoteImages: 0 },
		proxyRemoteImagesFor: message.id,
		linkify: true,
		dropFontFamily: readerFont !== undefined,
	};
	const htmlBody = collapseQuotedEmailHtml(
		sanitizeEmailHtml(resolveInlineAttachmentUrls(bodyDisplay.htmlBody, message.id, attachments), imageOptions),
	);
	const quotedHtml = collapseQuotedEmailHtml(
		sanitizeEmailHtml(resolveInlineAttachmentUrls(bodyDisplay.quotedHtml, message.id, attachments), imageOptions),
		true,
	);
	const cloudAttachmentResult = extractCloudAttachments(bodyDisplay.latestContent);
	// The same conservative extractor the server used for the notification, run
	// on the displayed text so a code that slipped through delivery still copies.
	const oneTimeCode = extractOneTimeCode({ subject: message.subject, text: bodyDisplay.latestContent });
	return (
		<InlineComposerHost messageId={message.id}>
			<div className="sticky top-0 z-40 flex h-14 items-center gap-1 border-b border-neutral-200 bg-white px-3">
				<MessageReadingHeaderButton />
				<MessageDetailNavigation messageId={message.id} unread={message.direction === "inbound" && !message.read} />
				<span className="min-w-0 flex-1" />
				<SummarizeButton controller={summary} />
				<MessageActions
					messageId={message.id}
					mailboxId={message.mailboxId}
					senderAddress={message.fromAddr}
					direction={message.direction}
					status={message.status}
					read={message.read}
					unsubscribeUrl={data.unsubscribeUrl}
					subject={message.subject}
					bodyText={body?.textBody}
					ownAddress={ownAddress}
					ownAddresses={ownAddresses}
					message={message}
					messageMeta={message}
					bodyHtml={body?.htmlBody}
					onSummarizeMessage={summary.summarizeMessage}
				/>
				<AssistantButton testId="assistant-button-reader" />
			</div>

			<div
				ref={scrollRef}
				data-reader-scroll
				onScroll={handleScroll}
				className="h-full overflow-y-auto overscroll-contain scrollbar-gutter-stable flex-1 min-h-0"
			>
				{!message.read && <MarkAsRead messageId={message.id} />}

				<ReaderThreadHeader
					subject={message.subject ?? "(no subject)"}
					count={threadSize}
					range={getThreadDateRange([
						message.createdAt,
						...thread.messages.map((threadMessage) => threadMessage.createdAt),
					])}
					participants={getThreadParticipants([
						{ name: fromName, address: fromAddress },
						...thread.messages.map((threadMessage) => ({
							name: getConversationSender(threadMessage, currentAccountName),
							address: getEmailAddress(threadMessage.fromAddr),
						})),
						...toEntries.map((entry) => ({ name: getEmailDisplayName(entry), address: getEmailAddress(entry) })),
					])}
					mailboxId={message.mailboxId}
					ownAddress={ownAddress}
					ownAddresses={ownAddresses}
				/>
				<OneTimeCodeChip code={oneTimeCode} alignWide={!isAnyPanelVisible} />
				<ScreenerBanner message={message} mailbox={messageMailbox} alignWide={!isAnyPanelVisible} />
				<SendStateBanner message={message} alignWide={!isAnyPanelVisible} />
				<ThreadSummaryCard key={message.id} controller={summary} />
				{/* <div className="px-6">
        <div className="mx-auto w-full max-w-[640px]">
          <SpamScoreDetails
            score={message.spamScore}
            verdict={message.spamVerdict}
            signals={message.spamSignals}
            analysisError={message.spamAnalysisError}
          />
        </div>
      </div> */}
				<ConversationThread
					currentMessageId={message.id}
					threadId={message.threadId}
					position={latestMessagesFirst ? "after" : "before"}
					messages={thread.messages}
					mailboxId={message.mailboxId}
					currentAccountName={currentAccountName}
					ownAddress={ownAddress}
					ownAddresses={ownAddresses}
					latestMessagesFirst={latestMessagesFirst}
					showFullRecipientAddresses={showFullRecipientAddresses}
					expandedAll={threadExpanded}
					onExpandedAllChange={setThreadExpanded}
					hideTriageSummary={hideTriageSummary}
				/>
				{/* Every message of the conversation is a section under a hairline, as in Zero's reader. */}
				<article className="border-t border-neutral-200 px-4 py-6 sm:px-7">
					<div className="w-full">
						<div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 pb-5">
							<div className="flex min-w-0 items-start gap-3">
								<ContactAvatar
									mailboxId={message.mailboxId}
									address={message.fromAddr}
									name={fromName}
									hasManagedAvatar={message.direction === "inbound"}
									managedAvatarUrl={
										message.direction === "outbound" && message.mailboxId
											? `/api/mailboxes/${message.mailboxId}/avatar`
											: undefined
									}
									className="mt-2"
								/>
								<div className="flex-1 min-w-0">
									<p className="text-sm text-neutral-900 mt-1.25 flex flex-row items-center gap-1 w-full  overflow-hidden">
										<b dir="auto" className="whitespace-nowrap">
											<ContactCard
												mailboxId={message.mailboxId}
												address={message.fromAddr}
												name={fromName}
												ownAddress={ownAddress}
												ownAddresses={ownAddresses}
												tooltip={false}
												triggerClassName="rounded-sm text-left hover:underline"
											>
												{fromName}
											</ContactCard>
										</b>{" "}
										<span className="text-neutral-500 text-xs flex-1 overflow-hidden text-ellipsis min-w-0">
											&lt;{fromAddress}&gt;
										</span>
									</p>
									<p className="text-xs text-neutral-500">
										to{" "}
										<RecipientList
											entries={toEntries}
											mailboxId={message.mailboxId}
											style={showFullRecipientAddresses ? "full" : "address"}
										/>
									</p>
									{ccEntries.length > 0 && (
										<p className="text-xs text-neutral-500">
											cc{" "}
											<RecipientList
												entries={ccEntries}
												mailboxId={message.mailboxId}
												style={showFullRecipientAddresses ? "full" : "address"}
											/>
										</p>
									)}
									{bccEntries.length > 0 && (
										<p className="text-xs text-neutral-500">
											bcc{" "}
											<RecipientList
												entries={bccEntries}
												mailboxId={message.mailboxId}
												style={showFullRecipientAddresses ? "full" : "address"}
											/>
										</p>
									)}
								</div>
							</div>
							<div className="flex shrink-0 items-center gap-2">
								<p className="text-xs">
									{formatUserDate(message.createdAt, {
										month: "short",
										day: "2-digit",
										year: "numeric",
										hour: "2-digit",
										minute: "2-digit",
									})}
								</p>
								<ThreadMessageActions
									message={currentThreadMessage}
									mailboxId={message.mailboxId}
									ownAddress={ownAddress}
									ownAddresses={ownAddresses}
									starOnly={
										!thread.messages.some((threadMessage) => threadMessage.id === message.id) ||
										!thread.messages.some((threadMessage) => threadMessage.id !== message.id)
									}
								/>
							</div>
						</div>
						<div className="prose mt-1 max-w-none text-neutral-900">
							{imageOptions.stats.blockedRemoteImages > 0 && (
								<RemoteImagesNotice onShow={() => setRemoteImagesShownFor(message.id)} />
							)}
							{htmlBody ? (
								<EmailHtmlFrame html={htmlBody} className="email-body mx-auto" />
							) : (
								<pre className="whitespace-pre-wrap text-sm text mx-auto">
									<LinkifiedText text={cloudAttachmentResult.content} />
								</pre>
							)}
							{quotedHtml && <QuotedEmailToggle html={quotedHtml} />}
							{bodyDisplay.quotedContent.map((quotedContent) => (
								<PreviousMessage
									key={`${quotedContent.dateLine}-${quotedContent.content.slice(0, 24)}`}
									message={quotedContent}
								/>
							))}
						</div>
						{cloudAttachmentResult.attachments.length > 0 && (
							<section className="mt-6">
								<h2 className="mb-2 text-sm text-neutral-500">
									Cloud files ({cloudAttachmentResult.attachments.length})
								</h2>
								<div className="grid gap-2 sm:grid-cols-2">
									{cloudAttachmentResult.attachments.map((attachment) => (
										<a
											key={attachment.id}
											href={attachment.url}
											target="_blank"
											rel="noreferrer"
											className="flex items-center gap-3 rounded-lg border border-neutral-200 p-3 text-left hover:border-blue-200 hover:bg-blue-50/40"
										>
											<Cloud className="h-5 w-5 shrink-0 text-blue-600" />
											<span className="min-w-0 flex-1">
												<span className="block truncate text-sm font-medium text-neutral-900">
													{attachment.filename}
												</span>
												<span className="block text-xs text-neutral-500">Open from {attachment.provider}</span>
											</span>
											<ExternalLink className="h-4 w-4 shrink-0 text-neutral-400" aria-hidden="true" />
											<span className="sr-only"> (opens in a new tab)</span>
										</a>
									))}
								</div>
							</section>
						)}
						{attachments.length > 0 && (
							<section className="mt-6">
								<h2 className="mb-2 text-sm text-neutral-500">Attachments ({attachments.length})</h2>
								<div className="flex flex-wrap gap-2">
									{attachments.map((attachment) => (
										<MessageAttachmentCard
											key={attachment.id}
											attachment={attachment}
											messageId={message.id}
											mailboxId={message.mailboxId ?? null}
											onPreview={setPreviewAttachment}
										/>
									))}
								</div>
							</section>
						)}
						<MessageReplyButtons
							mailboxId={message.mailboxId}
							senderAddress={message.fromAddr}
							direction={message.direction}
							subject={message.subject}
							bodyText={body?.textBody}
							bodyHtml={body?.htmlBody}
							ownAddress={ownAddress}
							ownAddresses={ownAddresses}
							message={message}
							messageMeta={message}
						/>
					</div>
				</article>
				<ConversationThread
					currentMessageId={message.id}
					threadId={message.threadId}
					position={latestMessagesFirst ? "before" : "after"}
					messages={thread.messages}
					mailboxId={message.mailboxId}
					currentAccountName={currentAccountName}
					ownAddress={ownAddress}
					ownAddresses={ownAddresses}
					latestMessagesFirst={latestMessagesFirst}
					showFullRecipientAddresses={showFullRecipientAddresses}
					expandedAll={threadExpanded}
					onExpandedAllChange={setThreadExpanded}
					hideTriageSummary={hideTriageSummary}
				/>
				<MessageAttachmentViewer
					attachment={previewAttachment}
					messageId={message.id}
					open={previewAttachment !== null}
					onOpenChange={(open) => {
						if (!open) setPreviewAttachment(null);
					}}
				/>
			</div>
			<InlineReplyComposer
				messageId={message.id}
				collapsed={
					<QuickReply
						name={fromName}
						message={message}
						body={body}
						ownAddress={ownAddress}
						ownAddresses={ownAddresses}
					/>
				}
			/>
		</InlineComposerHost>
	);
}
