import { useEffect, useState } from "react";
import { applyAppBadge, knownInboxUnread, supportsAppBadge } from "@/lib/app-badge-utils";
import { useMessageCounts } from "./use-message-counts";

/** Mirrors the all-mailbox Inbox unread count onto the installed app's icon while the dashboard is open. */
export function useAppBadge() {
	const [supported] = useState(() => typeof navigator !== "undefined" && supportsAppBadge(navigator));
	const { counts, isLoading } = useMessageCounts(null, supported);
	const [placeholder] = useState(counts);
	const unread = supported ? knownInboxUnread(counts, placeholder, isLoading) : null;

	useEffect(() => {
		if (unread !== null) void applyAppBadge(navigator, unread);
	}, [unread]);
}
