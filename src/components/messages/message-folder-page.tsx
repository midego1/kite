"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { useKeyChanged, useSyncedState } from "@/hooks/use-synced-state";
import { Archive, ChevronLeft, ChevronRight, ListFilter, Mail, MailOpen, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip } from "@/components/ui/tooltip";
import { useMailSearch } from "@/components/mail-search/mail-search-context";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { usePageLoading } from "@/components/page-loading";
import { useIsMobile } from "@/components/sidebar-mobile-utils";
import { useMessageCounts } from "@/hooks/use-message-counts";
import { useMessages } from "@/hooks/use-messages";
import type { BulkMessageAction } from "@/app/api/messages/bulk/types";
import type { Message } from "@/hooks/types";
import { setMessageDragData } from "@/lib/messages/drag-utils";
import { BulkMessageToolbar } from "./bulk-message-toolbar";
import { SwipeableRow } from "./swipeable-row";
import { useClearSelection } from "./use-clear-selection";
import { MessageListRowActions } from "./message-list-row-actions";
import { MessageRowParty, MessageRowStar } from "./message-row-parts";
import { applySelection, getRangeSelectionIds, rowCheckboxHandlers } from "./message-range-selection-utils";
import { dispatchMessageCountsDelta, toggleMessageStar } from "./message-list-row-actions-utils";
import { MessageNavigationProgress, useMessageNavigation } from "./message-navigation";
import { rememberOpenedUnreadMessage } from "./message-detail-navigation-utils";
import { useConversationView } from "./use-conversation-view";
import { getStackedRowDensity, getWideRowDensity } from "./reading-layout-utils";
import { useMessageListDensity } from "./use-reading-layout";
import type { MessageFolderPageProps, MessageListRowProps, RowMessageAction } from "./types";
import {
	formatMessageListTimestamp,
	getPageRange,
	getMessageParty,
	getMessagePartyClassName,
	getMessagePreview,
	isMessageListRowUnread,
	getMailboxAddress,
	getSelectionToolbarFolder,
	runBulkMessageAction,
	emptyMessageFolder,
	deleteMessagesForever,
} from "./utils";
import {
	getEmptyFolderConfirmText,
	getEmptyFolderLabel,
	getPermanentDeleteConfirmText,
	supportsPermanentDelete,
} from "@/lib/messages/permanent-delete-utils";
import clsx from "clsx";
import { requestConfirmation } from "@/components/ui/confirm-dialog-utils";
import { showProgressToast } from "@/components/ui/progress-toast";
import { confirmReportPhishing } from "./phishing-report";
import { reportListActionError } from "./list-action-toast";
import { useEmailPageTitle } from "./use-email-page-title";
import { FolderHeading } from "./folder-heading";

const pageSize = 25;

function MessageListRow({
	message,
	config,
	selected,
	active = false,
	compact = false,
	density = "default",
	hoverActions = true,
	currentAccountName,
	onSelectedChange,
	onMessageAction,
	dragMessageIds,
}: MessageListRowProps) {
	const Icon = config.icon;
	const [read, setRead] = useSyncedState(message.read);
	const [threadUnread, setThreadUnread] = useSyncedState(message.threadUnread);
	const [starred, setStarred] = useSyncedState(message.starred);
	const rowMessage = { ...message, read, starred, threadUnread };
	const unread = isMessageListRowUnread(rowMessage);
	const draggable = config.folder === "inbox" && message.direction === "inbound";
	const party = getMessageParty(rowMessage, config.folder, currentAccountName);
	const preview = getMessagePreview(rowMessage, config.folder);
	const href = `${config.hrefPrefix}/${message.id}`;
	const navigation = useMessageNavigation(href, rowMessage);

	async function runRowAction(action: RowMessageAction) {
		const previousRead = read;
		const previousThreadUnread = threadUnread;
		const unreadDelta = action === "read" ? -1 : action === "unread" ? 1 : 0;
		if (action === "read") setRead(true);
		if (action === "unread") setRead(false);
		// Grouped rows derive their unread styling from the thread count, so it must change with the row.
		if (message.threadMessageIds) {
			if (action === "read") setThreadUnread(0);
			if (action === "unread") setThreadUnread(message.threadMessageIds.length);
		}
		if (unreadDelta) dispatchMessageCountsDelta({ inboxUnreadDelta: unreadDelta });
		try {
			await onMessageAction(message.id, action);
		} catch (error) {
			if (action === "read" || action === "unread") {
				setRead(previousRead);
				setThreadUnread(previousThreadUnread);
				if (unreadDelta) dispatchMessageCountsDelta({ inboxUnreadDelta: -unreadDelta });
			}
			reportListActionError(error);
		}
	}

	const hasRowActions = (config.folder === "inbox" || config.folder === "snoozed") && message.direction === "inbound";
	const swipeable = compact && hasRowActions;
	const showHoverActions = hasRowActions && hoverActions;
	const starToggle = config.folder === "inbox" && message.direction === "inbound";

	function toggleStar(event: MouseEvent<HTMLButtonElement>) {
		event.preventDefault();
		event.stopPropagation();
		void toggleMessageStar(message.id)
			.then((result) => setStarred(result.starred))
			.catch(reportListActionError);
	}

	function onMessageNavigate(event: MouseEvent<HTMLAnchorElement>) {
		if (!read && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
			rememberOpenedUnreadMessage(message.id);
			const previousThreadUnread = threadUnread;
			setRead(true);
			if (previousThreadUnread !== undefined) setThreadUnread(Math.max(0, previousThreadUnread - 1));
			if (message.direction === "inbound") dispatchMessageCountsDelta({ inboxUnreadDelta: -1 });
			void runBulkMessageAction([message.id], "read", false).catch(() => {
				setRead(false);
				setThreadUnread(previousThreadUnread);
				if (message.direction === "inbound") dispatchMessageCountsDelta({ inboxUnreadDelta: 1 });
			});
		}
		navigation.onNavigate(event, !read);
	}

	if (compact && config.folder !== "drafts") {
		const stackedDensity = getStackedRowDensity(density);
		const compactRow = (
			<div
				role={swipeable ? undefined : "listitem"}
				className={`group relative grid grid-cols-[20px_minmax(0,1fr)] gap-3 border-l-2 px-4 ${stackedDensity.rowClassName} transition-colors ${
					active
						? "border-l-blue-600 bg-blue-50"
						: selected
							? "border-l-transparent bg-neutral-50"
							: "border-l-transparent hover:bg-neutral-50"
				} ${draggable ? "cursor-grab active:cursor-grabbing" : ""}`}
				draggable={draggable}
				onDragStart={(event) => {
					if (!draggable) return;
					setMessageDragData(event.dataTransfer, { messageIds: dragMessageIds });
				}}
			>
				<MessageNavigationProgress progress={navigation.progress} />
				<span className="flex flex-col items-center gap-1">
					<Checkbox
						checked={selected}
						{...rowCheckboxHandlers(message.id, onSelectedChange)}
						className="mt-1 h-4 w-4 rounded border-neutral-300"
						aria-label={`Select message from ${party}`}
					/>
					{starToggle && <MessageRowStar starred={starred} compact icon={Icon} onToggle={toggleStar} />}
				</span>
				<div className="relative min-w-0">
					<Link
						href={href}
						onClick={onMessageNavigate}
						aria-current={active ? "true" : undefined}
						className="block min-w-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
					>
						<span
							className={clsx(
								"flex items-baseline justify-between gap-3",
								showHoverActions && "group-hover:pr-[6.75rem] group-has-[:focus-visible]:pr-[6.75rem]",
							)}
						>
							<MessageRowParty
								party={party}
								unread={unread}
								threadCount={message.threadCount}
								suggestions={message.agentSuggestions}
								className={clsx("min-w-0 truncate", getMessagePartyClassName(rowMessage, config.folder))}
								countClassName="font-normal"
							/>
							<span
								className={clsx(
									unread ? "font-medium" : "text-neutral-400",
									"shrink-0 text-[11px]",
									showHoverActions && "group-hover:hidden group-has-[:focus-visible]:hidden",
								)}
							>
								{formatMessageListTimestamp(message.createdAt)}
							</span>
						</span>
						<span
							className={`mt-1 block truncate text-sm ${
								unread ? "font-semibold text-neutral-900" : "text-neutral-700"
							}`}
						>
							{message.subject ?? "(no subject)"}
						</span>
						{stackedDensity.showPreview && (
							<span className="mt-0.5 block truncate text-xs leading-5 text-neutral-500">{preview}</span>
						)}
					</Link>
					{showHoverActions && <MessageListRowActions message={rowMessage} onAction={runRowAction} compact />}
				</div>
			</div>
		);
		if (!swipeable) return compactRow;
		return (
			<SwipeableRow
				role="listitem"
				startAction={{
					label: read ? "Mark unread" : "Mark read",
					icon: read ? Mail : MailOpen,
					className: "bg-blue-600",
					onTrigger: () => void runRowAction(read ? "unread" : "read"),
				}}
				endAction={{
					label: "Archive",
					icon: Archive,
					className: "bg-emerald-600",
					onTrigger: () => void runRowAction("archive"),
				}}
			>
				{compactRow}
			</SwipeableRow>
		);
	}

	const className = `group relative grid ${getWideRowDensity(density).rowClassName} w-full grid-cols-[24px_32px_minmax(160px,260px)_1fr_auto] items-center gap-3 px-6 text-left text-sm hover:z-10 hover:bg-[#f2f6fc] hover:shadow-sm has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-inset has-[a:focus-visible]:ring-blue-600 ${
		active || selected ? "bg-blue-50" : ""
	} ${draggable ? "cursor-grab active:cursor-grabbing" : ""}`;
	const content = (
		<>
			{starToggle ? (
				<MessageRowStar starred={starred} compact={false} icon={Icon} onToggle={toggleStar} />
			) : (
				<Icon className="h-4 w-4 text-neutral-300" />
			)}
			<MessageRowParty
				party={party}
				unread={unread}
				threadCount={message.threadCount}
				suggestions={message.agentSuggestions}
				className={getMessagePartyClassName(rowMessage, config.folder)}
				countClassName=""
			/>
			<span className="truncate text-neutral-700">
				{/* The overlay stretches the link over the whole row, so a click anywhere opens the message
				while the row has one keyboard stop; the checkbox, star and hover actions sit above it. */}
				<Link
					href={href}
					onClick={config.folder === "drafts" ? undefined : onMessageNavigate}
					aria-current={active ? "true" : undefined}
					className="after:absolute after:inset-0 focus-visible:outline-none"
				>
					<span className={unread ? "font-semibold text-neutral-900" : ""}>{rowMessage.subject ?? "(no subject)"}</span>
					<span className="text-neutral-500"> - {getMessagePreview(rowMessage, config.folder)}</span>
				</Link>
			</span>
			<time
				dateTime={message.createdAt}
				className={`min-w-[96px] whitespace-nowrap text-right text-xs group-hover:opacity-0 ${
					unread ? "font-semibold text-neutral-800" : "text-neutral-500"
				}`}
			>
				{formatMessageListTimestamp(message.createdAt)}
			</time>
		</>
	);

	return (
		<div
			role="listitem"
			className={className}
			draggable={draggable}
			onDragStart={(event) => {
				if (!draggable) return;
				setMessageDragData(event.dataTransfer, { messageIds: dragMessageIds });
			}}
		>
			<MessageNavigationProgress progress={navigation.progress} />
			<Checkbox
				checked={selected}
				{...rowCheckboxHandlers(message.id, onSelectedChange)}
				className="relative z-10 h-4 w-4 rounded border-neutral-300"
				aria-label={
					config.folder === "drafts"
						? `Select draft ${rowMessage.subject ?? "(no subject)"}`
						: `Select message from ${party}`
				}
			/>
			{content}
			{hasRowActions && <MessageListRowActions message={rowMessage} onAction={runRowAction} />}
		</div>
	);
}

export function MessageFolderPage({ config, compact = false, selectedMessageId, selection }: MessageFolderPageProps) {
	const { selectedMailbox, isLoading: mailboxesLoading } = useSelectedMailbox();
	const { query } = useMailSearch();
	const isMobile = useIsMobile();
	const [offset, setOffset] = useState(0);
	// Cursor that starts the page at each offset, filled in as the user pages forward.
	const [pageCursors, setPageCursors] = useState<Record<number, string>>({});
	const [internalSelectedMessages, setInternalSelectedMessages] = useState<Array<{ id: string; read: boolean }>>([]);
	const [pendingBulkAction, setPendingBulkAction] = useState(false);
	const [emptyingFolder, setEmptyingFolder] = useState(false);
	const [unreadOnly, setUnreadOnly] = useState(false);
	const [conversationView] = useConversationView();
	const [density] = useMessageListDensity();
	const grouped = conversationView && config.folder !== "drafts";
	const { messages, isLoading, total, limit, nextCursor, updateMessages } = useMessages(
		config.folder,
		selectedMailbox?.id,
		{
			query,
			limit: pageSize,
			offset,
			cursor: offset > 0 ? pageCursors[offset] : null,
			read: unreadOnly ? "unread" : "all",
			group: grouped ? "thread" : undefined,
		},
		!mailboxesLoading,
		config.folderId,
	);
	const { counts } = useMessageCounts(selectedMailbox?.id, !mailboxesLoading);
	usePageLoading(mailboxesLoading || isLoading);
	const headerIcons = config.headerIcons ?? [];
	const hasActiveFilters = !!query.trim();
	const folderCount = config.folderId ? counts.customFolders[config.folderId] : counts.folders[config.folder];
	const titleTotal = folderCount?.total ?? total;
	const titleUnread = folderCount?.unread ?? 0;
	const mailboxAddress = getMailboxAddress(selectedMailbox);
	const currentAccountName = selectedMailbox?.displayName ?? selectedMailbox?.localPart;
	const pageRange = getPageRange(offset, messages.length, total);
	const selectedMessages = selection?.selectedMessages ?? internalSelectedMessages;
	const setSelectedMessages = selection?.setSelectedMessages ?? setInternalSelectedMessages;
	const selectedIds = useMemo(() => selectedMessages.map((message) => message.id), [selectedMessages]);
	const hasUnreadSelection = selectedMessages.some((message) => !message.read);
	const allVisibleSelected = messages.length > 0 && messages.every((message) => selectedIds.includes(message.id));
	// In conversation view a row stands for every message of its thread in this
	// folder, so actions and drags carry all of them.
	const rowMessageIds = (message: Message) => message.threadMessageIds ?? [message.id];
	const expandSelectedIds = (ids: string[]) =>
		ids.flatMap((id) => rowMessageIds(messages.find((message) => message.id === id) ?? ({ id } as Message)));

	const listKey = [query, selectedMailbox?.id, config.folder, config.folderId, unreadOnly, grouped].join("\u0000");
	if (useKeyChanged(listKey)) {
		setOffset(0);
		setPageCursors({});
	}

	// The setter can come from a parent's selection state and is not stable, so it is
	// left out of the dependencies; listing it would clear the selection on every render.
	const selectionAnchor = useRef<string | null>(null);
	useEffect(() => {
		selectionAnchor.current = null;
		setSelectedMessages([]);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [listKey, offset]);

	const { clearSelection, leaveOpenMessage } = useClearSelection(selection, setSelectedMessages, messages, isLoading);

	useEmailPageTitle(
		{ location: config.title, total: titleTotal, unread: titleUnread, emailAddress: mailboxAddress },
		mailboxesLoading,
	);

	function updateSelectedMessage(messageId: string, selected: boolean, extendRange = false) {
		const orderedIds = messages.map((message) => message.id);
		const ids = extendRange ? getRangeSelectionIds(orderedIds, selectionAnchor.current, messageId) : [messageId];
		selectionAnchor.current = messageId;
		setSelectedMessages((current) => applySelection(current, messages, ids, selected));
	}

	function toggleAllVisible(selected: boolean) {
		const visibleIds = messages.map((message) => message.id);
		setSelectedMessages((current) => applySelection(current, messages, visibleIds, selected));
	}

	const permanentDeleteFolder = !config.folderId && supportsPermanentDelete(config.folder) ? config.folder : null;
	async function emptyFolder() {
		if (!permanentDeleteFolder || !selectedMailbox?.id) return;
		if (
			!(await requestConfirmation({
				title: `Empty ${permanentDeleteFolder === "trash" ? "Trash" : "Spam"}?`,
				description: getEmptyFolderConfirmText(permanentDeleteFolder, titleTotal),
				confirmLabel: "Delete forever",
			}))
		)
			return;
		setEmptyingFolder(true);
		leaveOpenMessage();
		const folderLabel = permanentDeleteFolder === "trash" ? "Trash" : "Spam";
		const progress = showProgressToast(`Emptying ${folderLabel}`, titleTotal);
		try {
			const deleted = await emptyMessageFolder(selectedMailbox.id, permanentDeleteFolder, (done, total) =>
				progress.update(done, total),
			);
			setOffset(0);
			clearSelection();
			progress.succeed(deleted === 1 ? "1 message deleted forever" : `${deleted} messages deleted forever`);
		} catch (error) {
			console.error(error);
			progress.fail(`Could not empty ${folderLabel}. Please try again.`);
		} finally {
			setEmptyingFolder(false);
		}
	}

	async function runSelectedAction(action: BulkMessageAction, folderId?: string) {
		if (selectedIds.length === 0) return;
		if (action === "delete") {
			const ids = expandSelectedIds(selectedIds);
			if (
				!(await requestConfirmation({
					title: "Delete forever?",
					description: getPermanentDeleteConfirmText(ids.length),
					confirmLabel: "Delete forever",
				}))
			)
				return;
			setPendingBulkAction(true);
			clearSelection();
			const progress = showProgressToast("Deleting forever", ids.length);
			let completed = 0;
			try {
				const { deleted } = await deleteMessagesForever(ids, (done, _total, batch) => {
					completed = done;
					progress.update(done);
					const gone = new Set(batch);
					updateMessages((current) => current.filter((message) => !gone.has(message.id)));
				});
				progress.succeed(deleted === 1 ? "1 message deleted forever" : `${deleted} messages deleted forever`);
			} catch (error) {
				console.error(error);
				progress.fail(
					completed > 0
						? `Deleted ${completed} of ${ids.length}. The rest could not be deleted; please try again.`
						: "Could not delete the messages. Please try again.",
				);
			} finally {
				setPendingBulkAction(false);
			}
			return;
		}

		if (action === "phishing" && !(await confirmReportPhishing(expandSelectedIds(selectedIds).length))) return;
		setPendingBulkAction(true);
		const previousMessages = messages;
		const readValue = action === "read" ? true : action === "unread" ? false : null;
		const changedMessages =
			readValue === null
				? []
				: messages.filter((message) => selectedIds.includes(message.id) && message.read !== readValue);
		if (readValue !== null) {
			updateMessages((current) =>
				current.map((message) => (selectedIds.includes(message.id) ? { ...message, read: readValue } : message)),
			);
			setSelectedMessages((current) => current.map((message) => ({ ...message, read: readValue })));
			const inboxUnreadDelta = changedMessages
				.filter((message) => message.direction === "inbound")
				.reduce((total, message) => total + (readValue ? (message.read ? 0 : -1) : message.read ? 1 : 0), 0);
			if (inboxUnreadDelta) dispatchMessageCountsDelta({ inboxUnreadDelta });
		}
		try {
			await runBulkMessageAction(expandSelectedIds(selectedIds), action, true, folderId);
			clearSelection();
		} catch (error) {
			if (readValue !== null) {
				updateMessages(previousMessages);
				const inboxUnreadDelta = changedMessages
					.filter((message) => message.direction === "inbound")
					.reduce((total, message) => total + (readValue ? (message.read ? 0 : 1) : message.read ? -1 : 0), 0);
				if (inboxUnreadDelta) dispatchMessageCountsDelta({ inboxUnreadDelta });
			}
			reportListActionError(error);
		} finally {
			setPendingBulkAction(false);
		}
	}

	const registerAction = selection?.registerAction;
	useLayoutEffect(() => {
		if (!registerAction) return;
		registerAction(runSelectedAction);
		return () => registerAction(null);
	});

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div
				className={`flex h-14 shrink-0 items-center justify-between border-b border-neutral-200 ${compact ? "px-4" : "px-4.5 md:px-6"}`}
			>
				<FolderHeading title={config.title} nested={!!selectedMessageId} />
				<div className="flex items-center gap-3 w-full">
					<Tooltip label="Select all visible messages">
						<Checkbox
							checked={allVisibleSelected}
							disabled={messages.length === 0}
							onChange={(event) => toggleAllVisible(event.target.checked)}
							className="h-4 w-4 rounded border-neutral-300"
							aria-label="Select all visible messages"
						/>
					</Tooltip>
					{selectedIds.length > 0 && !compact ? (
						<BulkMessageToolbar
							selectedCount={selectedIds.length}
							hasUnreadSelection={hasUnreadSelection}
							onAction={runSelectedAction}
							onClearSelection={clearSelection}
							pending={pendingBulkAction}
							folder={getSelectionToolbarFolder(config)}
						/>
					) : (
						(compact || isMobile) && (
							<p aria-hidden="true" className="truncate font-semibold text-neutral-900 pl-1">
								{config.title}
							</p>
						)
					)}
				</div>
				{(selectedIds.length === 0 || compact) && (
					<div className="flex items-center gap-2 text-neutral-500">
						<span className="text-xs text-neutral-500 whitespace-nowrap">
							{pageRange.start} - {pageRange.end} of {pageRange.total}
						</span>
						<Tooltip label="Previous page">
							<Button
								variant="ghost"
								size="sm"
								disabled={offset === 0 || isLoading}
								onClick={() => setOffset(Math.max(offset - limit, 0))}
								aria-label="Previous page"
							>
								<ChevronLeft className="h-4 w-4" />
							</Button>
						</Tooltip>
						<Tooltip label="Next page">
							<Button
								variant="ghost"
								size="sm"
								disabled={offset + messages.length >= total || isLoading}
								onClick={() => {
									const nextOffset = offset + limit;
									if (nextCursor) setPageCursors((current) => ({ ...current, [nextOffset]: nextCursor }));
									setOffset(nextOffset);
								}}
								aria-label="Next page"
							>
								<ChevronRight className="h-4 w-4" />
							</Button>
						</Tooltip>
						{config.folder === "inbox" && (
							<Tooltip label={unreadOnly ? "Showing unread emails" : "Show unread emails only"}>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									aria-label="Show unread emails only"
									aria-pressed={unreadOnly}
									onClick={() => setUnreadOnly((current) => !current)}
									className={unreadOnly ? "bg-blue-100 text-blue-700 hover:bg-blue-100" : undefined}
								>
									<ListFilter className="h-4 w-4" />
								</Button>
							</Tooltip>
						)}
						{permanentDeleteFolder && (
							<Tooltip label={getEmptyFolderLabel(permanentDeleteFolder)}>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									aria-label={getEmptyFolderLabel(permanentDeleteFolder)}
									disabled={emptyingFolder || isLoading || total === 0}
									onClick={() => void emptyFolder()}
									className="gap-1.5 text-xs font-medium text-red-600 hover:text-red-700"
								>
									<Trash2 className="h-4 w-4" />
									{!compact && (
										<span className="max-md:hidden">
											{emptyingFolder ? "Emptying…" : getEmptyFolderLabel(permanentDeleteFolder)}
										</span>
									)}
								</Button>
							</Tooltip>
						)}
						{!compact && headerIcons.map((Icon, index) => <Icon key={index} className="h-4 w-4" />)}
					</div>
				)}
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-gutter-stable" data-density={density}>
				<div role="list" aria-label={config.title} className="divide-y divide-neutral-100">
					{messages.map((message) => (
						<MessageListRow
							key={message.id}
							message={message}
							config={config}
							selected={selectedIds.includes(message.id)}
							active={message.id === selectedMessageId}
							compact={compact || isMobile}
							density={density}
							hoverActions={!isMobile}
							currentAccountName={currentAccountName}
							onSelectedChange={updateSelectedMessage}
							onMessageAction={async (messageId, action) => {
								await runBulkMessageAction(
									expandSelectedIds([messageId]),
									action,
									action !== "read" && action !== "unread",
								);
							}}
							dragMessageIds={expandSelectedIds(selectedIds.includes(message.id) ? selectedIds : [message.id])}
						/>
					))}
				</div>
				{!isLoading && messages.length === 0 && (
					<div className="px-6 py-4">
						{!hasActiveFilters && (
							<p aria-hidden="true" className="font-script text-3xl text-blue-600">
								All clear.
							</p>
						)}
						<p className="text-sm text-neutral-500">
							{hasActiveFilters ? "No messages match these filters" : config.emptyText}
						</p>
					</div>
				)}
			</div>
		</div>
	);
}
