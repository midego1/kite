"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { MESSAGES_LEFT_VIEW_EVENT, openMessageLeft } from "./left-view-utils";

/**
 * Leaves the open message for its list. The message being left stays suppressed until the
 * pathname changes, whatever happens to the selection or the list meanwhile: its detail must not
 * mount or refetch (a 404 once the message is deleted) while the route is still committing.
 *
 * It also leaves on its own once an action takes the open message out of the list (Trash, a spam report,
 * Archive, a move, Snooze, from the reader, a row, a selection or a drop): the reader goes back to the empty
 * pane at once rather than when the route has committed, and Undo puts the message back in the list.
 */
export function useLeaveOpenMessage(selectedMessageId: string | undefined, listHref: string) {
	const router = useRouter();
	const [leavingMessageId, setLeavingMessageId] = useState<string | null>(null);
	// The latest values for the event listener, and the message already being left, so it is left once.
	const latest = useRef({ selectedMessageId, listHref, leavingMessageId });
	useEffect(() => {
		latest.current = { selectedMessageId, listHref, leavingMessageId };
	});
	useEffect(() => {
		// eslint-disable-next-line react-hooks/set-state-in-effect
		if (leavingMessageId !== null && leavingMessageId !== selectedMessageId) setLeavingMessageId(null);
	}, [leavingMessageId, selectedMessageId]);

	function leave(messageId: string, href: string) {
		if (latest.current.leavingMessageId === messageId) return;
		latest.current.leavingMessageId = messageId;
		setLeavingMessageId(messageId);
		router.replace(href);
	}

	useEffect(() => {
		function onLeftView(event: Event) {
			const ids = (event as CustomEvent<string[]>).detail ?? [];
			const { selectedMessageId: open, listHref: href } = latest.current;
			if (open && openMessageLeft(open, ids)) leave(open, href);
		}
		window.addEventListener(MESSAGES_LEFT_VIEW_EVENT, onLeftView);
		return () => window.removeEventListener(MESSAGES_LEFT_VIEW_EVENT, onLeftView);
		// `leave` reads everything through `latest`; the router is stable.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	function leaveOpenMessage() {
		if (!selectedMessageId) return;
		leave(selectedMessageId, listHref);
	}
	return { visibleMessageId: selectedMessageId === leavingMessageId ? undefined : selectedMessageId, leaveOpenMessage };
}
