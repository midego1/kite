import { authFetch } from "@/lib/auth/client";
import { getMessageQueryParams } from "@/hooks/utils";
import type { Message, MessageFolder, MessageListResponse } from "@/hooks/types";
import { t } from "@/lib/i18n/translator";

/** The server page size; see `limit` in `src/app/api/messages/route.ts`. */
const PAGE_SIZE = 100;

/**
 * How many messages "Select all in folder" will gather in one go. A folder can hold far more, and the bulk
 * route itself chunks its D1 queries so no single statement is too large (`src/db/chunk-utils.ts`), but the
 * request that then acts on the resolved ids still runs inside one Worker invocation; `runBulkMessageAction`
 * batches that request too (`bulk-action-batch-utils.ts`), so this cap is about keeping one resolve-and-act
 * round reasonably sized, not a parameter or query-count limit on either side.
 */
export const SELECT_ALL_MAX_MESSAGES = 1000;

export type SelectAllFilters = {
	query?: string;
	read?: "all" | "unread";
	/** Conversation view: each row stands for a thread, and carries every message id of it. */
	group?: "thread";
};

/**
 * One page of "Select all in folder", outside `fetchMessageList`'s shared cache: these pages page deep by
 * cursor and are not meant to be reused by the regular list, and unlike that helper this throws instead of
 * quietly caching an error body as if it were an empty page.
 */
async function fetchSelectAllPage(params: URLSearchParams): Promise<MessageListResponse> {
	const response = await authFetch(`/api/messages?${params}`);
	if (!response.ok) throw new Error(t("Could not load every matching message. Please try again."));
	return (await response.json()) as MessageListResponse;
}

/**
 * Every message (or, in conversation view, every thread row) matching the folder and its current filters,
 * resolved from the server page by page, up to `SELECT_ALL_MAX_MESSAGES`. Used by "Select all N in folder",
 * so a selection can reach past what the list has loaded. `truncated` is only ever true when the server still
 * had more to give (`nextCursor` was set); a folder with exactly the cap's worth of matches is not truncated.
 */
export async function resolveAllMatchingMessages(
	folder: MessageFolder,
	mailboxScope: string | null | undefined,
	filters: SelectAllFilters,
	folderId?: string | null,
): Promise<{ messages: Message[]; truncated: boolean }> {
	const collected: Message[] = [];
	let cursor: string | undefined;
	// From the first page: a folder whose count lands exactly on the cap still has `nextCursor` set (the page
	// was full, so the server cannot yet tell there is nothing after it), which `total` resolves without
	// another request.
	let total: number | undefined;
	for (;;) {
		const params = getMessageQueryParams(folder, mailboxScope, { ...filters, limit: PAGE_SIZE, cursor }, folderId);
		const data = await fetchSelectAllPage(params);
		collected.push(...(data.messages ?? []));
		if (total === undefined) total = data.total;
		if (total !== undefined && collected.length >= total) return { messages: collected, truncated: false };
		if (!data.nextCursor) return { messages: collected, truncated: false };
		if (collected.length >= SELECT_ALL_MAX_MESSAGES) {
			return { messages: collected.slice(0, SELECT_ALL_MAX_MESSAGES), truncated: true };
		}
		cursor = data.nextCursor;
	}
}
