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

	const latest = useRef({ rows, openMessageId, folder, folderId });
	useEffect(() => {
		latest.current = { rows, openMessageId, folder, folderId };
	});
	useEffect(() => {
		// Ends the watch of a leaving row that still holds the focus; a new change or the unmount ends it too.
		let stopWatch = () => {};
		function onLeftView(event: Event) {
			const change = (event as CustomEvent<MessagesLeftView>).detail;
			const current = latest.current;
			if (!change || !current.openMessageId || !change.ids.includes(current.openMessageId)) return;
			if (!leavesList(change.kind, current.folder, current.folderId)) return;
			const neighbour = neighbourAfterLeaving(
				current.rows.map((message) => message.id),
				current.openMessageId,
				change.ids,
			);
			// After the reader has unmounted, and only when the focus went down with it: dropped on the page, or still
			// on a row that is leaving (Trash in the row's own actions). The list may update well after the event (a
			// debounce and a fetch), so a focus on a leaving row is watched until that row has left; the watch ends
			// when the focus moves elsewhere (Undo kept the row, the user went on) or another change starts.
			const leaving = new Set([...change.ids, current.openMessageId]);
			const handOff = () => {
				const list = listRef.current;
				const link = neighbour
					? list?.querySelector<HTMLElement>(`[data-message-row="${CSS.escape(neighbour)}"] a[href]`)
					: null;
				(link ?? list)?.focus();
			};
			const leavingRowOf = (element: Element | null) => {
				const row = element?.closest<HTMLElement>("[data-message-row]")?.getAttribute("data-message-row");
				return row != null && leaving.has(row) ? row : null;
			};
			const settle = () => {
				const active = document.activeElement;
				if (!active || active === document.body || !active.isConnected) return handOff();
				if (!leavingRowOf(active)) return;
				watch(active);
			};
			const watch = (active: Element) => {
				stopWatch();
				const list = listRef.current;
				if (!list) return;
				const observer = new MutationObserver(() => {
					if (active.isConnected) return;
					stopWatch();
					const now = document.activeElement;
					if (!now || now === document.body || !now.isConnected || leavingRowOf(now)) handOff();
				});
				observer.observe(list, { childList: true, subtree: true });
				const onFocusIn = (focus: FocusEvent) => {
					if (!leavingRowOf(focus.target as Element | null)) stopWatch();
				};
				document.addEventListener("focusin", onFocusIn);
				stopWatch = () => {
					observer.disconnect();
					document.removeEventListener("focusin", onFocusIn);
					stopWatch = () => {};
				};
			};
			stopWatch();
			requestAnimationFrame(() => requestAnimationFrame(settle));
		}
		window.addEventListener(MESSAGES_LEFT_VIEW_EVENT, onLeftView);
		return () => {
			stopWatch();
			window.removeEventListener(MESSAGES_LEFT_VIEW_EVENT, onLeftView);
		};
	}, [listRef]);
}
