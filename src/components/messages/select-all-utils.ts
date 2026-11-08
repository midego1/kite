import { fetchMessageList, getMessageQueryParams } from "@/hooks/utils";
import type { Message, MessageFolder } from "@/hooks/types";

/** The server page size; see `limit` in `src/app/api/messages/route.ts`. */
const PAGE_SIZE = 100;

/**
 * How many messages "Select all in folder" will gather in one go. The bulk route itself has no limit of its
 * own (it chunks its D1 queries, see `src/db/chunk-utils.ts`), but one request still runs inside one Worker
 * invocation, so a very large folder is capped rather than resolved in full.
 */
export const SELECT_ALL_MAX_MESSAGES = 1000;

export type SelectAllFilters = {
	query?: string;
	read?: "all" | "unread";
	/** Conversation view: each row stands for a thread, and carries every message id of it. */
	group?: "thread";
};

/**
 * Every message (or, in conversation view, every thread row) matching the folder and its current filters,
 * resolved from the server page by page, up to `SELECT_ALL_MAX_MESSAGES`. Used by "Select all N in folder",
 * so a selection can reach past what the list has loaded.
 */
export async function resolveAllMatchingMessages(
	folder: MessageFolder,
	mailboxScope: string | null | undefined,
	filters: SelectAllFilters,
	folderId?: string | null,
): Promise<{ messages: Message[]; truncated: boolean }> {
	const collected: Message[] = [];
	let cursor: string | undefined;
	for (;;) {
		const params = getMessageQueryParams(folder, mailboxScope, { ...filters, limit: PAGE_SIZE, cursor }, folderId);
		const data = await fetchMessageList(params, true);
		collected.push(...(data.messages ?? []));
		if (collected.length >= SELECT_ALL_MAX_MESSAGES) {
			return { messages: collected.slice(0, SELECT_ALL_MAX_MESSAGES), truncated: true };
		}
		if (!data.nextCursor) return { messages: collected, truncated: false };
		cursor = data.nextCursor;
	}
}
