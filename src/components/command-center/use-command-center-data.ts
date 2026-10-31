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
import type { MessageFolderConfig } from "@/components/messages/types";
import { canConnectAccounts, statusChipsInput } from "./command-center-utils";

/**
 * Everything the command center shows, from data the mailbox loads anyway where it can: the session, the
 * mailboxes and their counts, the open suggestions (the For you sidebar item's list), the connected accounts
 * (the Settings page's query, shared). The admin card loads its own data (command-center-admin-card.tsx).
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

	const chips = statusChipsInput({
		unread: folderCount?.unread,
		folderTitle: config.title,
		folderHref: config.hrefPrefix,
		held: counts.folders.screener?.total,
		screener: selectedMailbox?.screener,
		suggestions,
	});

	const accounts: readonly ExternalAccountView[] = connected.data?.accounts ?? [];

	return {
		user,
		chips,
		countsLoading: countsLoading || mailboxesLoading,
		unread: chips.unread,
		accounts,
		/** The mailbox selected, null for all mailboxes; the module cards get it. */
		mailboxId: selectedMailbox?.id ?? null,
		/** Whether the user may connect accounts at all; the card is hidden when not. */
		canConnect: canConnectAccounts(connected.data),
		isAdmin,
		primary,
	};
}
