"use client";

import type { MouseEvent } from "react";
import { useSyncedState } from "@/hooks/use-synced-state";
import { affectsInboxUnreadCount, getInboxUnreadDelta, withReadState } from "@/lib/messages/thread-unread-utils";
import { reportListActionError } from "./list-action-toast";
import { rememberOpenedUnreadMessage } from "./message-detail-navigation-utils";
import { dispatchMessageCountsDelta, toggleMessageStar } from "./message-list-row-actions-utils";
import { useMessageNavigation } from "./message-navigation";
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
}: Pick<MessageListRowProps, "message" | "config" | "currentAccountName" | "canManage" | "onMessageAction">) {
	const [read, setRead] = useSyncedState(message.read);
	const [threadUnread, setThreadUnread] = useSyncedState(message.threadUnread);
	const [starred, setStarred] = useSyncedState(message.starred);
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

	function onNavigate(event: MouseEvent<HTMLAnchorElement>) {
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
		draggable: config.folder === "inbox" && inbound && canManage,
		starToggle: config.folder === "inbox" && inbound,
		hasRowActions,
		runRowAction,
		toggleStar,
		onNavigate,
	};
}
