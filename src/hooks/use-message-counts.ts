import { useEffect, useState } from "react";
import type { MessageCounts, MessageCountsDelta } from "./types";
import { clearMessageCountsCache, fetchMessageCounts } from "./utils";
import { createEmptyFolderCounts } from "@/app/api/messages/counts/utils";

const REFRESH_DEBOUNCE_MS = 150;

const emptyCounts: MessageCounts = {
	folders: createEmptyFolderCounts(),
	customFolders: {},
	mailboxes: [],
};

export function useMessageCounts(mailboxId?: string | null, enabled = true) {
	const [counts, setCounts] = useState<MessageCounts>(emptyCounts);
	const [isLoading, setIsLoading] = useState(enabled);

	useEffect(() => {
		if (!enabled) return;

		let cancelled = false;
		let refreshTimer: number | null = null;
		let requestNumber = 0;
		let staleWhileHidden = false;

		async function loadCounts(force = false) {
			const currentRequest = ++requestNumber;
			setIsLoading(true);
			try {
				const nextCounts = await fetchMessageCounts(mailboxId, force);
				if (!cancelled && currentRequest === requestNumber) setCounts(nextCounts ?? emptyCounts);
			} finally {
				if (!cancelled && currentRequest === requestNumber) setIsLoading(false);
			}
		}

		void loadCounts();
		function onMessagesChanged() {
			clearMessageCountsCache();
			requestNumber += 1;
			if (document.visibilityState !== "visible") {
				if (refreshTimer) window.clearTimeout(refreshTimer);
				refreshTimer = null;
				staleWhileHidden = true;
				setIsLoading(true);
				return;
			}
			staleWhileHidden = false;
			if (refreshTimer) window.clearTimeout(refreshTimer);
			refreshTimer = window.setTimeout(() => {
				refreshTimer = null;
				if (document.visibilityState !== "visible") {
					staleWhileHidden = true;
					setIsLoading(true);
					return;
				}
				void loadCounts(true);
			}, REFRESH_DEBOUNCE_MS);
		}
		function onVisibilityChange() {
			if (staleWhileHidden && document.visibilityState === "visible") onMessagesChanged();
		}
		function onMessageCountsDelta(event: Event) {
			const detail = (event as CustomEvent<MessageCountsDelta>).detail;
			const inboxUnreadDelta = detail?.inboxUnreadDelta;
			if (!inboxUnreadDelta) return;
			setCounts((current) => ({
				...current,
				folders: {
					...current.folders,
					inbox: {
						...current.folders.inbox,
						unread: Math.max(0, current.folders.inbox.unread + inboxUnreadDelta),
					},
				},
			}));
		}
		window.addEventListener("kite:messages-changed", onMessagesChanged);
		window.addEventListener("kite:message-counts-changed", onMessagesChanged);
		window.addEventListener("kite:message-counts-delta", onMessageCountsDelta);
		document.addEventListener("visibilitychange", onVisibilityChange);

		return () => {
			cancelled = true;
			window.removeEventListener("kite:messages-changed", onMessagesChanged);
			window.removeEventListener("kite:message-counts-changed", onMessagesChanged);
			window.removeEventListener("kite:message-counts-delta", onMessageCountsDelta);
			document.removeEventListener("visibilitychange", onVisibilityChange);
			if (refreshTimer) window.clearTimeout(refreshTimer);
		};
	}, [enabled, mailboxId]);

	return { counts, isLoading: enabled && isLoading };
}
