"use client";

import type { MouseEvent } from "react";
import { useSyncedState } from "@/hooks/use-synced-state";
import { LIST_SUMMARIES_PREFERENCE } from "@/components/appearance-preferences";
import { useAppearancePreference } from "@/components/use-appearance-preference";
import { affectsInboxUnreadCount, getInboxUnreadDelta, withReadState } from "@/lib/messages/thread-unread-utils";
import { reportListActionError } from "./list-action-toast";
import { rememberOpenedUnreadMessage } from "./message-detail-navigation-utils";
import { dispatchMessageCountsDelta, toggleMessageStar } from "./message-list-row-actions-utils";
import { useMessageNavigation } from "./message-navigation";
import { isApplePlatform, rowClickModifiers } from "./message-range-selection-utils";
import type { MessageListRowProps, RowMessageAction } from "./types";
import { getMessageParty, getMessagePreview, isMessageListRowUnread, runBulkMessageAction } from "./utils";

function isPlainClick(event: MouseEvent) {
	return !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/** A list row's optimistic read and star state, and the actions that change them. */
export function useMessageListRow({
	message,
	config,
	currentAccountName,
	canManage = true,
	onMessageAction,
	onRowClick,
}: Pick<
	MessageListRowProps,
	"message" | "config" | "currentAccountName" | "canManage" | "onMessageAction" | "onRowClick"
>) {
	const [read, setRead] = useSyncedState(message.read);
	const [threadUnread, setThreadUnread] = useSyncedState(message.threadUnread);
	const [starred, setStarred] = useSyncedState(message.starred);
	const [listSummaries] = useAppearancePreference(LIST_SUMMARIES_PREFERENCE);
	const rowMessage = { ...message, read, starred, threadUnread };
	const href = `${config.hrefPrefix}/${message.id}`;
	const navigation = useMessageNavigation(href, rowMessage);
	const affectsInboxCount = affectsInboxUnreadCount(config);
	const inbound = message.direction === "inbound";
	const hasRowActions = (config.folder === "inbox" || config.folder === "snoozed") && inbound && canManage;

	function setReadState(value: boolean, unread: number | undefined) {
		setRead(value);
		setThreadUnread(unread);
	}

	async function runRowAction(action: RowMessageAction) {
		const previous = { read, threadUnread };
		const readValue = action === "read" ? true : action === "unread" ? false : null;
		const unreadDelta = getInboxUnreadDelta([rowMessage], readValue, affectsInboxCount);
		// Grouped rows derive their unread styling from the thread count, so it must change with the row.
		if (readValue !== null) {
			const next = withReadState(rowMessage, readValue);
			setReadState(next.read, next.threadUnread);
		}
		if (unreadDelta) dispatchMessageCountsDelta({ inboxUnreadDelta: unreadDelta });
		try {
			await onMessageAction(message.id, action);
		} catch (error) {
			if (readValue !== null) {
				setReadState(previous.read, previous.threadUnread);
				if (unreadDelta) dispatchMessageCountsDelta({ inboxUnreadDelta: -unreadDelta });
			}
			reportListActionError(error);
		}
	}

	function toggleStar(event: MouseEvent<HTMLButtonElement>) {
		event.preventDefault();
		event.stopPropagation();
		void toggleMessageStar(message.id)
			.then((result) => setStarred(result.starred))
			.catch(reportListActionError);
	}

	function markOpenedRead() {
		rememberOpenedUnreadMessage(message.id);
		const previousThreadUnread = threadUnread;
		setReadState(true, previousThreadUnread === undefined ? undefined : Math.max(0, previousThreadUnread - 1));
		const inboxUnreadDelta = getInboxUnreadDelta([{ direction: message.direction, read }], true, affectsInboxCount);
		if (inboxUnreadDelta) dispatchMessageCountsDelta({ inboxUnreadDelta });
		void runBulkMessageAction([message.id], "read", false).catch(() => {
			setReadState(false, previousThreadUnread);
			if (inboxUnreadDelta) dispatchMessageCountsDelta({ inboxUnreadDelta: -inboxUnreadDelta });
		});
	}

	/**
	 * Shift-, Cmd- or Ctrl-click selects the row for the list instead of opening it; any other click is also
	 * reported, so a plain click can become the anchor of the next range. Returns true when the click selected.
	 */
	function selectedByClick(event: MouseEvent<HTMLAnchorElement>) {
		const modifiers = rowClickModifiers(event, isApplePlatform(navigator.platform || navigator.userAgent));
		// A plain click anchors the next range; Alt-click and a Mac context click leave the selection alone.
		if (modifiers || isPlainClick(event)) onRowClick?.(message.id, modifiers);
		if (modifiers) event.preventDefault();
		return modifiers !== null;
	}

	/** The click handler of a row that has no navigation of its own (drafts open in the composer). */
	function onSelectClick(event: MouseEvent<HTMLAnchorElement>) {
		selectedByClick(event);
	}

	function onNavigate(event: MouseEvent<HTMLAnchorElement>) {
		if (selectedByClick(event)) return;
		if (!read && isPlainClick(event)) markOpenedRead();
		navigation.onNavigate(event, !read);
	}

	return {
		rowMessage,
		read,
		starred,
		href,
		navigation,
		unread: isMessageListRowUnread(rowMessage),
		party: getMessageParty(rowMessage, config.folder, currentAccountName),
		preview: getMessagePreview(rowMessage, config.folder),
		line: listSummaries === "summaries" ? message.lineSummary : undefined,
		draggable: config.folder === "inbox" && inbound && canManage,
		starToggle: config.folder === "inbox" && inbound,
		hasRowActions,
		runRowAction,
		toggleStar,
		onNavigate,
		onSelectClick,
		/** Cancels the text selection a Shift-click would start; the row still takes the focus, without scrolling. */
		onMouseDown: (event: MouseEvent<HTMLAnchorElement>) => {
			if (!event.shiftKey) return;
			event.preventDefault();
			event.currentTarget.focus({ preventScroll: true });
		},
	};
}
