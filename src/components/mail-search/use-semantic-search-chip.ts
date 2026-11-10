import { useStoredSwitch } from "@/components/messages/use-stored-switch";
import { SEMANTIC_SEARCH_CHANGE_EVENT, SEMANTIC_SEARCH_STORAGE_KEY } from "./semantic-search-chip-utils";

/**
 * The By meaning chip in the mail search box: on by default (when search by meaning is available for the install;
 * the server falls back to keyword-only and says so otherwise), remembered per browser.
 * `docs/specs/semantic-search.md` section 6.
 */
export function useSemanticSearchChip(): [boolean, (next: boolean) => void] {
	return useStoredSwitch(SEMANTIC_SEARCH_STORAGE_KEY, SEMANTIC_SEARCH_CHANGE_EVENT, true);
}
