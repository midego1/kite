/**
 * The kite's return after a reload to a new version (the sequel to reload-flight.tsx). Reload in the "Kite was
 * updated" notice writes a marker to sessionStorage before the page reloads; the reloaded document's inline
 * `reloadReturnBootstrapScript` reads it in <head>, before the first paint, and puts RELOAD_RETURN_CLASS on <html>
 * so the server-rendered startup screen (LoadingTransition) draws the kite flying back in and floating on its
 * string instead of the plain logo. Pure CSS (`reload-return-*` in globals.css), so nothing waits on JavaScript
 * and the boot watchdog (asset-recovery-utils.ts) sees no activity it could mistake for progress. The marker
 * expires by itself, so a reload that never came, or a later ordinary reload, never shows the scene.
 */

/** sessionStorage key holding the time (ms since the epoch) Reload was chosen in the update notice. */
const RELOAD_RETURN_STORAGE_KEY = "kite-reload-flight";
/** A marker older than this, or from a clock that ran ahead, is ignored and removed (the rule lives in the script). */
const RELOAD_RETURN_TTL_MS = 60_000;
/** Put on <html> while the startup screen shows the kite's return. */
const RELOAD_RETURN_CLASS = "kite-reload-return";
/** What the startup screen's live region says while the new version loads. */
export const RELOAD_RETURN_ANNOUNCEMENT = "Loading the new version…";
/** The visible line of the reduced-motion variant, which shows the kite standing still. */
export const RELOAD_RETURN_STATIC_TEXT = "Updating Kite…";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function sessionStorageOrNull(): StorageLike | null {
	try {
		return typeof sessionStorage === "undefined" ? null : sessionStorage;
	} catch {
		return null;
	}
}

/** Reload was chosen in the update notice: the next load of this tab shows the kite's return. */
export function markReloadReturn(storage: StorageLike | null = sessionStorageOrNull(), now = Date.now()): void {
	try {
		storage?.setItem(RELOAD_RETURN_STORAGE_KEY, String(now));
	} catch {
		// Storage can be unavailable; the reload then boots with the plain startup screen.
	}
}

/** The reload did not happen, or the app is up: a later load shows the plain startup screen again. */
export function clearReloadReturnMarker(storage: StorageLike | null = sessionStorageOrNull()): void {
	try {
		storage?.removeItem(RELOAD_RETURN_STORAGE_KEY);
	} catch {
		// Nothing to clear, or storage is unavailable; the marker expires by itself.
	}
}

/** Whether this document started with the kite's return (the inline script found a fresh marker). */
export function isReloadReturnActive(): boolean {
	return typeof document !== "undefined" && document.documentElement.classList.contains(RELOAD_RETURN_CLASS);
}

/** The app is up and the startup screen has gone: the scene stops and the marker is cleared. */
export function endReloadReturn(): void {
	clearReloadReturnMarker();
	if (typeof document !== "undefined") document.documentElement.classList.remove(RELOAD_RETURN_CLASS);
}

/**
 * Runs in <head> before paint, after the theme script, so the first frame already shows the kite's return. It only
 * adds a class (no nodes: the boot watchdog counts parser-added nodes as progress while the document streams).
 * A marker counts while it is within RELOAD_RETURN_TTL_MS of now, either way round (a clock that jumped is as
 * stale as an old marker); anything else is removed. A fresh marker stays until the app is up (`endReloadReturn`),
 * so an automatic reload by the asset recovery while the new version's files settle keeps the story going.
 */
export const reloadReturnBootstrapScript = `(() => {
	try {
		const key = ${JSON.stringify(RELOAD_RETURN_STORAGE_KEY)};
		const raw = sessionStorage.getItem(key);
		if (raw === null) return;
		const at = Number(raw);
		if (!Number.isFinite(at) || Math.abs(Date.now() - at) > ${RELOAD_RETURN_TTL_MS}) {
			sessionStorage.removeItem(key);
			return;
		}
		document.documentElement.classList.add(${JSON.stringify(RELOAD_RETURN_CLASS)});
	} catch {}
})();`;
