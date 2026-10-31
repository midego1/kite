"use client";

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { Message } from "@/hooks/types";
import { leavesList, MESSAGES_LEFT_VIEW_EVENT, neighbourAfterLeaving, type MessagesLeftView } from "./left-view-utils";
import type { MessageSelectionControl } from "./types";

type OpenRowBridgeOptions = {
	selection: MessageSelectionControl | undefined;
	/** The rows in the order they are shown. */
	rows: readonly Message[];
	rowMessageIds: (message: Message) => string[];
	openMessageId: string | undefined;
	listRef: RefObject<HTMLElement | null>;
	folder: string;
	folderId?: string | null;
};

/**
 * Connects the list to the open message: the reader asks it which ids the open message's row stands for, and when
 * the open message leaves the list the keyboard focus goes to the row next to it (else the list) instead of being
 * dropped on the page with the reader.
 */
export function useOpenRowBridge({
	selection,
	rows,
	rowMessageIds,
	openMessageId,
	listRef,
	folder,
	folderId,
}: OpenRowBridgeOptions) {
	const registerRowLookup = selection?.registerRowLookup;
	useLayoutEffect(() => {
		if (!registerRowLookup) return;
		registerRowLookup((messageId) => {
			const row = rows.find((message) => rowMessageIds(message).includes(messageId));
			return row ? rowMessageIds(row) : null;
		});
		return () => registerRowLookup(null);
	});

	const latest = useRef({ rows, rowMessageIds, openMessageId, folder, folderId });
	useEffect(() => {
		latest.current = { rows, rowMessageIds, openMessageId, folder, folderId };
	});
	useEffect(() => {
		function onLeftView(event: Event) {
			const change = (event as CustomEvent<MessagesLeftView>).detail;
			const current = latest.current;
			if (!change || !current.openMessageId || !change.ids.includes(current.openMessageId)) return;
			if (!leavesList(change.kind, current.folder, current.folderId)) return;
			const rowById = new Map(current.rows.map((message) => [message.id, message]));
			const neighbour = neighbourAfterLeaving([...rowById.keys()], current.openMessageId, change.ids, (rowId) => {
				const row = rowById.get(rowId);
				return row ? current.rowMessageIds(row) : [rowId];
			});
			// After the reader has unmounted, and only when the focus went down with it.
			requestAnimationFrame(() =>
				requestAnimationFrame(() => {
					const active = document.activeElement;
					if (active && active !== document.body && active.isConnected) return;
					const list = listRef.current;
					const link = neighbour
						? list?.querySelector<HTMLElement>(`[data-message-row="${CSS.escape(neighbour)}"] a[href]`)
						: null;
					(link ?? list)?.focus();
				}),
			);
		}
		window.addEventListener(MESSAGES_LEFT_VIEW_EVENT, onLeftView);
		return () => window.removeEventListener(MESSAGES_LEFT_VIEW_EVENT, onLeftView);
	}, [listRef]);
}
