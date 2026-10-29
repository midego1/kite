import { useStoredSwitch } from "./use-stored-switch";

const STORAGE_KEY = "kite-load-remote-images";
const CHANGE_EVENT = "kite:load-remote-images-changed";

/** Whether messages load remote images without asking. Off by default: remote images can track reads. */
export function useLoadRemoteImages(): [boolean, (enabled: boolean) => void] {
	return useStoredSwitch(STORAGE_KEY, CHANGE_EVENT, false);
}
