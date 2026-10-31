import { clearReloadReturnMarker, markReloadReturn } from "./reload-return-utils";
import { cancelReload, requestReload } from "./update-notice-store";

/**
 * Loads the deployment that is waiting. The "Kite was updated" toast and the pinned list row both call this, so
 * there is one place for what happens when someone chooses Reload: the host plays the kite's flight
 * (reload-flight.tsx), then reloads, and the reloaded page's startup screen shows the kite coming back
 * (reload-return-scene.tsx), asked for by the marker written here, while RELOAD_RETURN_ENABLED is on (it is off for
 * now: the reloaded page starts like a refresh). A second call while it is under way does nothing.
 */
export function reloadToNewVersion() {
	markReloadReturn();
	requestReload();
}

/** The reload did not happen (the user stayed on the page): the notice returns and the next load is an ordinary one. */
export function cancelReloadToNewVersion() {
	clearReloadReturnMarker();
	cancelReload();
}
