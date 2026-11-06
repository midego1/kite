"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useOptionalMailSearch } from "@/components/mail-search/mail-search-context";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { useCurrentUser } from "@/hooks/use-current-user";
import { authFetch } from "@/lib/auth/client";
import {
	accountViewsIn,
	activeAccountView,
	isAccountOutside,
	openViewName,
	parseAccountViews,
	type AccountViewEntry,
} from "@/lib/external-accounts/account-views-utils";

// Under ["external-accounts"] so connecting, renaming or removing an account on its settings page refreshes the sidebar.
const ACCOUNT_VIEWS_QUERY_KEY = ["external-accounts", "views"];

async function fetchAccountViews(): Promise<AccountViewEntry[]> {
	const response = await authFetch("/api/external-accounts", { cache: "no-store" });
	if (!response.ok) throw new Error(`Connected accounts request failed (${response.status})`);
	return parseAccountViews(await response.json());
}

/** The viewer's own connected accounts as views; undefined while loading or when the request failed. */
export function useOwnAccountViews(): AccountViewEntry[] | undefined {
	const user = useCurrentUser();
	const { data } = useQuery({
		queryKey: [...ACCOUNT_VIEWS_QUERY_KEY, user?.id],
		queryFn: fetchAccountViews,
		enabled: !!user,
		staleTime: 60_000,
		retry: false,
	});
	return data;
}

/**
 * The viewer's own connected accounts that deliver into a mailbox in view (one mailbox, or every mailbox of All
 * mailboxes), as sidebar views, and the one whose view is open. Empty until loaded, when the user has none and
 * before migration 0079.
 */
export function useAccountViews(): { entries: AccountViewEntry[]; active: AccountViewEntry | null } {
	const pathname = usePathname();
	const search = useOptionalMailSearch();
	const { viewMailboxes, isLoading } = useSelectedMailbox();
	const data = useOwnAccountViews();
	const entries = accountViewsIn(
		data ?? [],
		viewMailboxes.map((mailbox) => mailbox.id),
	);
	// Switching to a mailbox that does not receive the open view's account leaves the view, since it would list nothing
	// of that mailbox's. Only once both lists are known, so a view opened from a link is not closed while loading.
	const view = search?.view ?? null;
	const setView = search?.setView;
	const stale = !!view && !isLoading && viewMailboxes.length > 0 && !!data && isAccountOutside(data, entries, view);
	useEffect(() => {
		if (stale) setView?.(null, { replace: true });
	}, [stale, setView]);
	return { entries, active: activeAccountView(entries, search?.view ?? null, pathname) };
}

/**
 * The account view that is open, with its name and the way out, or null. The name comes from the accounts once they
 * load (the address until then); `close` is the way back to the plain list.
 */
export function useOpenAccountView(): { address: string; label: string; close: () => void } | null {
	const search = useOptionalMailSearch();
	const accounts = useOwnAccountViews();
	if (!search?.view) return null;
	return {
		address: search.view,
		label: openViewName(accounts, search.view),
		close: () => search.setView(null),
	};
}
