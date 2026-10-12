import type { OpenSuggestionsState } from "./open-suggestions-types";
import { useSuggestionList } from "./use-suggestion-list";

/**
 * Open suggestions across the mailboxes where the user has full access, refreshed whenever a
 * suggestion or the mail changes. A failed refresh keeps the last list.
 */
export function useOpenSuggestions(): OpenSuggestionsState & { reload: () => void } {
	const { data, reload } = useSuggestionList<Partial<Omit<OpenSuggestionsState, "loaded">>>(
		"/api/agent/suggestions?status=open",
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
