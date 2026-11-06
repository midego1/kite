import type { OpenSuggestionsState } from "./open-suggestions-types";
import { useSuggestionList } from "./use-suggestion-list";

/**
 * Open suggestions across the mailboxes where the user has full access, refreshed whenever a
 * suggestion or the mail changes. A failed refresh keeps the last list. With a `mailboxId` the list (and its limit of
 * 200 rows and its total) is that mailbox's own, so other mailboxes cannot crowd it out; it answers 404, which
 * leaves the list unloaded, for a mailbox without full access.
 */
export function useOpenSuggestions(mailboxId?: string): OpenSuggestionsState & { reload: () => void } {
	const { data, reload } = useSuggestionList<Partial<Omit<OpenSuggestionsState, "loaded">>>(
		mailboxId
			? `/api/agent/suggestions?status=open&mailboxId=${encodeURIComponent(mailboxId)}`
			: "/api/agent/suggestions?status=open",
	);
	const suggestions = data?.suggestions ?? [];
	return {
		loaded: data !== null,
		suggestions,
		total: data?.total ?? suggestions.length,
		kindTotals: data?.kindTotals ?? {},
		mailboxes: data?.mailboxes ?? [],
		reload,
	};
}
