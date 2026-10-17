type ThreadMember = { id: string; key: string; read: boolean; direction: string };

type UnreadRow = {
	direction: string;
	read: boolean;
	threadUnread?: number;
	threadMessageIds?: string[];
};

export type ScopedThreads = { ids: Map<string, string[]>; unread: Map<string, number> };

/**
 * Collects the messages each conversation row stands for in the current folder,
 * with how many of them are unread. The row's unread state must come from these
 * messages, because marking the row read changes only them.
 */
export function groupThreadMembers(members: ThreadMember[]): ScopedThreads {
	const ids = new Map<string, string[]>();
	const unread = new Map<string, number>();
	for (const { id, key, read, direction } of members) {
		const list = ids.get(key) ?? [];
		list.push(id);
		ids.set(key, list);
		unread.set(key, (unread.get(key) ?? 0) + (!read && direction === "inbound" ? 1 : 0));
	}
	return { ids, unread };
}

/** How many unread messages a read or unread action on this row would flip. */
function getUnreadFlipCount(message: UnreadRow, readValue: boolean): number {
	if (message.threadMessageIds) {
		const size = message.threadMessageIds.length;
		const unread = Math.min(Math.max(message.threadUnread ?? 0, 0), size);
		return readValue ? unread : size - unread;
	}
	if (message.direction !== "inbound") return 0;
	return message.read === readValue ? 0 : 1;
}

/** Only the Inbox list itself, not a custom folder or another status, moves the sidebar Inbox count. */
export function affectsInboxUnreadCount(config: { folder: string; folderId?: string | null }): boolean {
	return config.folder === "inbox" && !config.folderId;
}

/**
 * The change to the sidebar Inbox unread count when these rows are marked read
 * (`readValue` true) or unread; `null` is any other action.
 */
export function getInboxUnreadDelta(rows: UnreadRow[], readValue: boolean | null, affectsInbox: boolean): number {
	if (!affectsInbox || readValue === null) return 0;
	const flipped = rows.reduce((total, row) => total + getUnreadFlipCount(row, readValue), 0);
	if (flipped === 0) return 0;
	return readValue ? -flipped : flipped;
}

/** The row after a read or unread action, with a conversation row's unread count to match. */
export function withReadState<T extends UnreadRow>(row: T, readValue: boolean): T {
	if (!row.threadMessageIds) return { ...row, read: readValue };
	return { ...row, read: readValue, threadUnread: readValue ? 0 : row.threadMessageIds.length };
}
