import { getMessageQueryParams, fetchMessageList } from "@/hooks/utils";
import type { MessageFolder } from "@/hooks/types";
import { readConversationViewEnabled } from "@/components/messages/use-conversation-view";

/**
 * Warms the list cache with the exact request the folder page will make, so
 * the page renders from cache when navigation lands.
 */
export async function preloadMailboxPage(href: string, mailboxId?: string) {
	const customFolderMatch = href.match(/^\/folders\/([^/]+)$/);
	const folder = (customFolderMatch ? "inbox" : href.slice(1)) as MessageFolder;
	const supportedFolders: MessageFolder[] = [
		"inbox",
		"starred",
		"snoozed",
		"sent",
		"drafts",
		"archived",
		"spam",
		"trash",
	];
	if (!supportedFolders.includes(folder)) return;

	const grouped = folder !== "drafts" && readConversationViewEnabled();
	const params = getMessageQueryParams(
		folder,
		mailboxId,
		{ limit: 25, offset: 0, group: grouped ? "thread" : undefined },
		customFolderMatch?.[1],
	);
	await fetchMessageList(params);
}
