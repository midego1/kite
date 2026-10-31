"use client";

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCurrentUser } from "@/hooks/use-current-user";
import { AGENT_SUGGESTION_EVENT, MODULE_NOTICE_EVENT } from "@/hooks/message-realtime-utils";

/** Under one key, so a module notice, a suggestion or a module's own page can refresh every card at once. */
const COMMAND_CENTER_CARDS_QUERY_KEY = ["command-center-cards"];
/** The pane remounts whenever a message is closed; a card's data is reused across that for a minute. */
const CARD_STALE_MS = 60_000;

/**
 * A command center card's data, kept for a minute across the pane's remounts and per account (an account switch
 * clears the query cache). `null` while it loads and when it failed, so the card draws nothing. `key` names the
 * card and anything its data depends on, such as the day.
 */
export function useCommandCenterCardQuery<T>(key: readonly unknown[], load: () => Promise<T>): T | null {
	const userId = useCurrentUser()?.id ?? null;
	const { data } = useQuery({
		queryKey: [...COMMAND_CENTER_CARDS_QUERY_KEY, userId, ...key],
		queryFn: load,
		enabled: !!userId,
		staleTime: CARD_STALE_MS,
		refetchOnMount: true,
		retry: false,
	});
	return data ?? null;
}

/** Marks every card's data stale, so the next pane fetches it again: for a module page where it can change. */
export function useStaleCommandCenterCards(): void {
	const queryClient = useQueryClient();
	useEffect(() => {
		void queryClient.invalidateQueries({ queryKey: COMMAND_CENTER_CARDS_QUERY_KEY, refetchType: "none" });
	}, [queryClient]);
}

/** Refreshes the cards when a module sends a notice or a suggestion changes (a subscription tracked, an invite). */
export function useCommandCenterCardEvents(): void {
	const queryClient = useQueryClient();
	useEffect(() => {
		const refresh = () => void queryClient.invalidateQueries({ queryKey: COMMAND_CENTER_CARDS_QUERY_KEY });
		window.addEventListener(MODULE_NOTICE_EVENT, refresh);
		window.addEventListener(AGENT_SUGGESTION_EVENT, refresh);
		return () => {
			window.removeEventListener(MODULE_NOTICE_EVENT, refresh);
			window.removeEventListener(AGENT_SUGGESTION_EVENT, refresh);
		};
	}, [queryClient]);
}
