import { queueLayoutSave } from "@/components/layout-preferences-client";
import { CONVERSATION_VIEW_CHANGE_EVENT, CONVERSATION_VIEW_STORAGE_KEY } from "./conversation-view-utils";
import { readStoredSwitch, useStoredSwitch } from "./use-stored-switch";

/** Whether lists are grouped by conversation, readable outside React (e.g. to preload a list). */
export function readConversationViewEnabled(): boolean {
	return readStoredSwitch(CONVERSATION_VIEW_STORAGE_KEY, true);
}

const saveToAccount = (conversationView: boolean) => queueLayoutSave({ conversationView });

/**
 * Whether lists collapse each conversation to one row. On by default, remembered
 * in the browser and saved to the account; every open list follows a change immediately.
 */
export function useConversationView(): [boolean, (next: boolean) => void] {
	return useStoredSwitch(CONVERSATION_VIEW_STORAGE_KEY, CONVERSATION_VIEW_CHANGE_EVENT, true, saveToAccount);
}
