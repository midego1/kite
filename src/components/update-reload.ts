import { requestReload } from "./update-notice-store";

/**
 * Loads the deployment that is waiting. The "Kite was updated" toast and the pinned list row both call this, so
 * there is one place for what happens when someone chooses Reload: the host plays the kite's flight
 * (reload-flight.tsx), then reloads. A second call while it is under way does nothing.
 */
export function reloadToNewVersion() {
	requestReload();
}
