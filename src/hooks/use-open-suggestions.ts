import type { OpenSuggestion, OpenSuggestionsState, SuggestionMailbox } from "./open-suggestions-types";
import { useSuggestionList } from "./use-suggestion-list";

/**
 * Open suggestions across the mailboxes where the user has full access, refreshed whenever a
 * suggestion or the mail changes. A failed refresh keeps the last list.
 */
export function useOpenSuggestions(): OpenSuggestionsState & { reload: () => void } {
	const { data, reload } = useSuggestionList<{ suggestions?: OpenSuggestion[]; mailboxes?: SuggestionMailbox[] }>(
		"/api/agent/suggestions?status=open",
	);
	return { loaded: data !== null, suggestions: data?.suggestions ?? [], mailboxes: data?.mailboxes ?? [], reload };
}
