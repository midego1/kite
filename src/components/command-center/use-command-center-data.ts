"use client";

import { useQuery } from "@tanstack/react-query";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import {
	CONNECTED_ACCOUNTS_QUERY_KEY,
	fetchConnectedAccounts,
} from "@/components/settings/connected-accounts/connected-accounts-utils";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useMessageCounts } from "@/hooks/use-message-counts";
import { useOpenSuggestions } from "@/hooks/use-open-suggestions";
import type { ExternalAccountView } from "@/lib/external-accounts/types";
import { attentionItems } from "@/app/(admin)/admin/overview-utils";
import type { AttentionItem, OverviewData } from "@/app/(admin)/admin/overview-types";
import { useOverview } from "@/app/(admin)/admin/use-overview";
import type { MessageFolderConfig } from "@/components/messages/types";
import { canConnectAccounts, statusChipsInput } from "./command-center-utils";

/**
 * Everything the command center shows, from data the mailbox loads anyway where it can: the session, the
 * mailboxes and their counts, the open suggestions (the For you sidebar item's list), the connected accounts
 * (the Settings page's query, shared) and, for admins only, the admin overview's parts under the keys its cards
 * use, read from the cache while they are fresh instead of on every mount of the empty pane.
 */
export function useCommandCenterData(config: MessageFolderConfig) {
	const user = useCurrentUser();
	const { selectedMailbox, mailboxScope, isLoading: mailboxesLoading } = useSelectedMailbox();
	const { counts, isLoading: countsLoading } = useMessageCounts(mailboxScope, !mailboxesLoading);
	const suggestions = useOpenSuggestions();
	const folderCount = config.folderId ? counts.customFolders[config.folderId] : counts.folders[config.folder];

	const connected = useQuery({
		queryKey: CONNECTED_ACCOUNTS_QUERY_KEY,
		queryFn: fetchConnectedAccounts,
		enabled: Boolean(user),
		staleTime: 60_000,
		retry: false,
	});

	const isAdmin = user?.role === "admin";
	const primary = isAdmin && user.isPrimaryAdmin === true;
	const overview = useOverview(primary, isAdmin, { refetchOnMount: true });

	const chips = statusChipsInput({
		unread: folderCount?.unread,
		folderTitle: config.title,
		held: counts.folders.screener?.total,
		screener: selectedMailbox?.screener,
		suggestions,
	});

	const accounts: readonly ExternalAccountView[] = connected.data?.accounts ?? [];
	// The pane's own notice card already shows waiting database updates with Apply now; the list keeps the rest.
	const attention: AttentionItem[] = isAdmin
		? attentionItems(overview.data, primary).filter((item) => item.id !== "migrations")
		: [];
	const overviewData: OverviewData | null = isAdmin ? overview.data : null;

	return {
		user,
		chips,
		countsLoading: countsLoading || mailboxesLoading,
		unread: chips.unread,
		accounts,
		/** Whether the user may connect accounts at all; the card is hidden when not. */
		canConnect: canConnectAccounts(connected.data),
		isAdmin,
		primary,
		attention,
		attentionLoading: isAdmin && overview.loading,
		overviewData,
	};
}
