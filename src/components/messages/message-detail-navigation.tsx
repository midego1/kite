"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { useHotkeys, useShortcuts } from "@/components/shortcuts";
import { authFetch } from "@/lib/auth/client";
import { setMailboxScopeParam } from "@/hooks/utils";
import type { MessageNavigationResponse } from "@/app/api/messages/navigation/types";
import type {
	MessageDetailNavigationContextValue,
	MessageDetailNavigationProps,
	MessageDetailNavigationProviderProps,
	MessageDetailNavigationSnapshot,
	OpenedUnreadMessages,
} from "./message-detail-navigation-types";
import {
	getMessageDetailNavigationState,
	readerNavigationShortcuts,
	takeOpenedUnreadMessage,
} from "./message-detail-navigation-utils";
import { useConversationView } from "./use-conversation-view";

const NavigationContext = createContext<MessageDetailNavigationContextValue | null>(null);

export function MessageDetailNavigationProvider({ children, config }: MessageDetailNavigationProviderProps) {
	const { mailboxScope, isLoading: mailboxesLoading } = useSelectedMailbox();
	const [conversationView] = useConversationView();
	const grouped = conversationView && config.folder !== "drafts";
	const mailboxId = mailboxScope;
	const key = `${config.folder}:${config.folderId ?? ""}:${mailboxId ?? "all"}:${grouped}`;
	const [snapshot, setSnapshot] = useState<MessageDetailNavigationSnapshot>({ key: "", entries: [] });
	const [openedUnread, setOpenedUnread] = useState<OpenedUnreadMessages>({ key: "", ids: new Set() });
	const recordUnread = useCallback(
		(messageId: string) => {
			setOpenedUnread((current) => {
				const ids = new Set(current.key === key ? current.ids : []);
				ids.add(messageId);
				return { key, ids };
			});
		},
		[key],
	);

	useEffect(() => {
		// Taking the id consumes it from sessionStorage, so it cannot happen during render.
		const messageId = takeOpenedUnreadMessage();
		// eslint-disable-next-line react-hooks/set-state-in-effect
		if (messageId) recordUnread(messageId);
	}, [recordUnread]);

	useEffect(() => {
		if (mailboxesLoading) return;
		let cancelled = false;
		const params = new URLSearchParams({ folder: config.folder });
		if (config.folderId) params.set("folderId", config.folderId);
		setMailboxScopeParam(params, mailboxId);
		if (grouped) params.set("group", "thread");
		void authFetch(`/api/messages/navigation?${params.toString()}`)
			.then((response) => {
				if (!response.ok) throw new Error("Unable to load message navigation");
				return response.json() as Promise<MessageNavigationResponse>;
			})
			.then((response) => {
				if (!cancelled) setSnapshot({ key, entries: response.messages });
			})
			.catch(() => {
				if (!cancelled) setSnapshot({ key, entries: [] });
			});
		return () => {
			cancelled = true;
		};
	}, [config.folder, config.folderId, grouped, key, mailboxId, mailboxesLoading]);

	const unreadIds = openedUnread.key === key ? openedUnread.ids : null;
	const entries =
		snapshot.key === key
			? snapshot.entries.map((entry) => ({ ...entry, unread: entry.unread || !!unreadIds?.has(entry.id) }))
			: [];
	return (
		<NavigationContext.Provider value={{ entries, hrefPrefix: config.hrefPrefix, recordUnread }}>
			{children}
		</NavigationContext.Provider>
	);
}

/** The list the open message was opened from, or null outside a folder layout. */
export function useMessageListHref(): string | null {
	return useContext(NavigationContext)?.hrefPrefix ?? null;
}

export function MessageDetailNavigation({ messageId, unread }: MessageDetailNavigationProps) {
	const context = useContext(NavigationContext);
	const router = useRouter();
	const { shortcutsEnabled } = useShortcuts();
	useEffect(() => {
		if (unread) context?.recordUnread(messageId);
	}, [context?.recordUnread, messageId, unread]);
	const { previousId, nextId, unreadOrder, totalUnread } = getMessageDetailNavigationState(
		context?.entries ?? [],
		messageId,
	);
	const open = (id: string | null) => {
		if (id && context) router.push(`${context.hrefPrefix}/${id}`);
	};
	useHotkeys(
		readerNavigationShortcuts((direction) => open(direction === "older" ? nextId : previousId)),
		{ enabled: shortcutsEnabled && !!context },
	);
	if (!context) return null;

	return (
		<div className="ml-auto flex shrink-0 items-center gap-1 text-neutral-500 sm:gap-2">
			{totalUnread > 0 && (
				<span className="mr-2 whitespace-nowrap text-xs max-sm:sr-only" aria-live="polite">
					{unreadOrder} of {totalUnread} unread
				</span>
			)}
			<Tooltip label={shortcutsEnabled ? "Newer email (k)" : "Newer email"}>
				<Button
					type="button"
					variant="ghost"
					size="roundedSM"
					aria-label="Newer email"
					disabled={!previousId}
					onClick={() => open(previousId)}
				>
					<ChevronLeft size={18} />
				</Button>
			</Tooltip>
			<Tooltip label={shortcutsEnabled ? "Older email (j)" : "Older email"}>
				<Button
					type="button"
					variant="ghost"
					size="roundedSM"
					aria-label="Older email"
					disabled={!nextId}
					onClick={() => open(nextId)}
				>
					<ChevronRight size={18} />
				</Button>
			</Tooltip>
		</div>
	);
}
