import { useEffect, useLayoutEffect, useState } from "react";
import type { Message, MessageFilterOptions, MessageFolder, MessageListResponse } from "./types";
import {
	clearMessageCountsCache,
	clearMessageListCache,
	fetchMessageList,
	getCachedMessageList,
	getMessageQueryParams,
} from "./utils";

const REFRESH_DEBOUNCE_MS = 150;
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function useMessages(
	folder: MessageFolder,
	mailboxId?: string | null,
	filters?: MessageFilterOptions,
	enabled = true,
	folderId?: string | null,
) {
	const [messages, setMessages] = useState<Message[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [total, setTotal] = useState(0);
	const [limit, setLimit] = useState(filters?.limit ?? 25);
	const [offset, setOffset] = useState(filters?.offset ?? 0);
	const [nextCursor, setNextCursor] = useState<string | null>(null);

	const unreadCount = messages.filter((m) => m.direction === "inbound" && !m.read).length;

	// A layout effect so a list already in the cache is painted on the first frame
	// instead of flashing an empty "0 of 0" list until the async fetch resolves.
	useIsomorphicLayoutEffect(() => {
		if (!enabled) return;
		let cancelled = false;
		let refreshTimer: number | null = null;
		let requestNumber = 0;

		function apply(data: MessageListResponse) {
			setMessages(data.messages ?? []);
			setTotal(data.total ?? 0);
			setLimit(data.limit ?? filters?.limit ?? 25);
			setOffset(data.offset ?? filters?.offset ?? 0);
			setNextCursor(data.nextCursor ?? null);
		}

		async function loadMessages(force = false, showLoading = false) {
			const currentRequest = ++requestNumber;
			if (showLoading) setIsLoading(true);
			try {
				const params = getMessageQueryParams(folder, mailboxId, filters, folderId);
				const data = await fetchMessageList(params, force);
				if (!cancelled && currentRequest === requestNumber) apply(data);
			} finally {
				if (!cancelled && currentRequest === requestNumber) setIsLoading(false);
			}
		}

		const cached = getCachedMessageList(getMessageQueryParams(folder, mailboxId, filters, folderId));
		if (cached) {
			apply(cached);
			setIsLoading(false);
		} else {
			void loadMessages(false, true);
		}
		function onMessagesChanged() {
			clearMessageListCache();
			clearMessageCountsCache();
			if (document.visibilityState !== "visible") return;
			if (refreshTimer) window.clearTimeout(refreshTimer);
			refreshTimer = window.setTimeout(() => {
				refreshTimer = null;
				void loadMessages(true);
			}, REFRESH_DEBOUNCE_MS);
		}
		window.addEventListener("kite:messages-changed", onMessagesChanged);

		return () => {
			cancelled = true;
			window.removeEventListener("kite:messages-changed", onMessagesChanged);
			if (refreshTimer) window.clearTimeout(refreshTimer);
		};
	}, [
		enabled,
		filters?.cursor,
		filters?.group,
		filters?.limit,
		filters?.offset,
		filters?.query,
		filters?.read,
		filters?.title,
		folder,
		folderId,
		mailboxId,
	]);

	return { messages, unreadCount, isLoading, total, limit, offset, nextCursor, updateMessages: setMessages };
}
