import type { Message } from "@/hooks/types";

export type ListSection = {
	key: "pinned" | "primary" | "all";
	/** Shown over the rows; null for a list without sections. */
	label: string | null;
	messages: Message[];
	/** Shown beside the label; null for Primary, whose total the pager already shows. */
	count: number | null;
};

/**
 * Zero's "Pinned" and "Primary" groups for the Inbox: Kite has no pins, so starred mail on the page is pinned.
 * Without grouping, or with nothing starred on the page, the list is one unlabelled section in its own order.
 */
export function groupListSections(messages: Message[], grouped: boolean): ListSection[] {
	if (!grouped) return [{ key: "all", label: null, messages, count: null }];
	const pinned = messages.filter((message) => message.starred);
	const rest = messages.filter((message) => !message.starred);
	if (pinned.length === 0) return [{ key: "primary", label: "Primary", messages: rest, count: null }];
	return [
		{ key: "pinned", label: "Pinned", messages: pinned, count: pinned.length },
		{ key: "primary", label: "Primary", messages: rest, count: null },
	];
}
