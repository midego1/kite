import { useStoredSwitch } from "./use-stored-switch";

const STORAGE_KEY = "kite-latest-messages-first";
const CHANGE_EVENT = "kite:latest-messages-first-changed";

/** Whether conversations display newest to oldest. Enabled by default. */
export function useLatestMessagesFirst(): [boolean, (next: boolean) => void] {
	return useStoredSwitch(STORAGE_KEY, CHANGE_EVENT, true);
}
