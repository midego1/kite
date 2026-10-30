/**
 * Loads the deployment that is waiting. The "Kite was updated" toast and the pinned list row both call this, so
 * anything that should happen when someone chooses Reload (an animation, a flush of unsaved state) goes here.
 */
export function reloadToNewVersion() {
	window.location.reload();
}
