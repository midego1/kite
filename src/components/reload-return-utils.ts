/**
 * The kite's return after a reload to a new version (the sequel to reload-flight.tsx). Reload in the "Kite was
 * updated" notice writes a marker to sessionStorage before the page reloads; the reloaded document's inline
 * `reloadReturnBootstrapScript` reads it in <head>, before the first paint, and puts RELOAD_RETURN_CLASS on <html>
 * so the server-rendered startup screen (LoadingTransition) draws the kite flying back in and floating on its
 * string instead of the plain logo. Pure CSS (`reload-return-*` in globals.css), so nothing waits on JavaScript
 * and the boot watchdog (asset-recovery-utils.ts) sees no activity it could mistake for progress. The marker
 * expires by itself, so a reload that never came, or a later ordinary reload, never shows the scene.
 *
 * The scene is strictly cosmetic: the script consumes the marker as it reads it, so only the one load right after
 * Reload shows it (a refresh, or the boot watchdog's own reload, starts plainly), and it takes the class off
 * again after RELOAD_RETURN_MAX_MS whatever React does, so a startup that does not finish shows the plain
 * startup screen, with its own recovery, instead of a kite that looks as if it were still loading.
 */

/**
 * Off since 2026-10-31, as a stopgap: the startup screen froze (bar stuck at 15–21%, kite swinging, no timer
 * running) only on the load right after Reload in "Kite was updated", while a plain refresh of the same page always
 * started. With this off, Reload writes no marker and the inline script only removes one (a tab still on an older
 * build writes it before reloading into this one), so that load behaves exactly like a refresh: no class, no
 * scene. Turn it back on once the cause is known; the scene, its CSS and its specs are kept for that.
 */
export const RELOAD_RETURN_ENABLED = false;
/** sessionStorage key holding the time (ms since the epoch) Reload was chosen in the update notice. */
const RELOAD_RETURN_STORAGE_KEY = "kite-reload-flight";
/** A marker older than this, or from a clock that ran ahead, is ignored and removed (the rule lives in the script). */
const RELOAD_RETURN_TTL_MS = 60_000;
/** Put on <html> while the startup screen shows the kite's return. */
const RELOAD_RETURN_CLASS = "kite-reload-return";
/** The longest the scene stays (the boot watchdog's first look, too): a startup still going by then gets the plain screen. */
const RELOAD_RETURN_MAX_MS = 8_000;
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

/** Reload was chosen in the update notice: the next load of this tab shows the kite's return (when enabled). */
export function markReloadReturn(
	storage: StorageLike | null = sessionStorageOrNull(),
	now = Date.now(),
	enabled = RELOAD_RETURN_ENABLED,
): void {
	if (!enabled) return;
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
 * stale as an old marker). The marker is removed whatever it held, so no later load of this tab replays the scene,
 * and a timer takes the class off after RELOAD_RETURN_MAX_MS even if the app never comes up (`endReloadReturn`
 * ends it sooner once it does).
 */
export const reloadReturnBootstrapScript = reloadReturnScript(RELOAD_RETURN_ENABLED);

/** The inline script; while the scene is off it only removes a marker, so the load is an ordinary one. */
function reloadReturnScript(enabled: boolean): string {
	return `(() => {
	try {
		const key = ${JSON.stringify(RELOAD_RETURN_STORAGE_KEY)};
		const raw = sessionStorage.getItem(key);
		if (raw === null) return;
		sessionStorage.removeItem(key);
		if (!${JSON.stringify(enabled)}) return;
		const at = Number(raw);
		if (!Number.isFinite(at) || Math.abs(Date.now() - at) > ${RELOAD_RETURN_TTL_MS}) return;
		const root = document.documentElement;
		root.classList.add(${JSON.stringify(RELOAD_RETURN_CLASS)});
		setTimeout(() => root.classList.remove(${JSON.stringify(RELOAD_RETURN_CLASS)}), ${RELOAD_RETURN_MAX_MS});
	} catch {}
})();`;
}
