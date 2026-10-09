"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Leaves the open message for its list. The message being left stays suppressed until the
 * pathname changes, whatever happens to the selection or the list meanwhile: its detail must not
 * mount or refetch (a 404 once the message is deleted) while the route is still committing.
 */
export function useLeaveOpenMessage(selectedMessageId: string | undefined, listHref: string) {
	const router = useRouter();
	const [leavingMessageId, setLeavingMessageId] = useState<string | null>(null);
	useEffect(() => {
		// eslint-disable-next-line react-hooks/set-state-in-effect
		if (leavingMessageId !== null && leavingMessageId !== selectedMessageId) setLeavingMessageId(null);
	}, [leavingMessageId, selectedMessageId]);

	function leaveOpenMessage() {
		if (!selectedMessageId) return;
		setLeavingMessageId(selectedMessageId);
		router.replace(listHref);
	}
	return { visibleMessageId: selectedMessageId === leavingMessageId ? undefined : selectedMessageId, leaveOpenMessage };
}
