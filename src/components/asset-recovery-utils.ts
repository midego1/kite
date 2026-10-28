/** sessionStorage key counting the automatic reloads of this tab: `{ count, since }`. */
const ASSET_RELOAD_STORAGE_KEY = "kite:asset-reload";
/** Set on `window` once the app has rendered; from then on a failed chunk never reloads by itself. */
const ASSET_RECOVERY_READY_FLAG = "__kiteAppReady";
/** Fired on `window` when a chunk fails after the app has rendered, so the update check can run at once. */
export const STALE_ASSETS_EVENT = "kite:stale-assets";
/** Waits before each automatic reload; their count is the most a tab reloads within the window below. */
const ASSET_RELOAD_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;
const ASSET_RELOAD_WINDOW_MS = 120_000;

/*
 * Runs in <head> before the app's entry script. Right after a deploy the page and its chunks can come from
 * different versions of the Worker (a deployment reaches Cloudflare's locations one by one), so the document
 * names chunks that the version answering the next request does not have: they answer 404, the entry module
 * never runs and the page stays on its server-rendered "Loading" shell. A same-origin script, module preload or
 * stylesheet that fails, or a dynamic import that does, before the app has rendered reloads the tab after a
 * short wait, at most ASSET_RELOAD_DELAYS_MS.length times per ASSET_RELOAD_WINDOW_MS. After the app has
 * rendered it only fires STALE_ASSETS_EVENT, because a reload could throw away what the user is typing.
 * Offline failures are left alone.
 */
export const assetRecoveryScript = `(() => {
	const key = ${JSON.stringify(ASSET_RELOAD_STORAGE_KEY)};
	const delays = ${JSON.stringify(ASSET_RELOAD_DELAYS_MS)};
	const windowMs = ${ASSET_RELOAD_WINDOW_MS};
	let handled = false;
	const sameOrigin = (url) => {
		try {
			return new URL(url, location.href).origin === location.origin;
		} catch {
			return false;
		}
	};
	const readState = () => {
		try {
			const state = JSON.parse(sessionStorage.getItem(key) || "null");
			return state && typeof state.count === "number" && typeof state.since === "number" ? state : null;
		} catch {
			return null;
		}
	};
	const recover = () => {
		if (handled || navigator.onLine === false) return;
		handled = true;
		if (window[${JSON.stringify(ASSET_RECOVERY_READY_FLAG)}]) {
			window.dispatchEvent(new Event(${JSON.stringify(STALE_ASSETS_EVENT)}));
			return;
		}
		const now = Date.now();
		let state = readState();
		if (!state || now - state.since > windowMs || state.since > now) state = { count: 0, since: now };
		if (state.count >= delays.length) {
			console.error("[kite] The app's files could not be loaded after " + delays.length + " reloads.");
			return;
		}
		const next = { count: state.count + 1, since: state.since };
		try {
			sessionStorage.setItem(key, JSON.stringify(next));
		} catch {
			return;
		}
		// Without a stored count nothing would stop a reload loop.
		if (readState()?.count !== next.count) return;
		setTimeout(() => location.reload(), delays[state.count]);
	};
	addEventListener(
		"error",
		(event) => {
			const target = event.target;
			if (target instanceof HTMLScriptElement) {
				if (target.src && sameOrigin(target.src)) recover();
			} else if (target instanceof HTMLLinkElement) {
				if (/(^|\\s)(modulepreload|stylesheet)(\\s|$)/i.test(target.rel) && sameOrigin(target.href)) recover();
			}
		},
		true,
	);
	addEventListener("vite:preloadError", recover);
	addEventListener("unhandledrejection", (event) => {
		const reason = event.reason;
		const message = String((reason && reason.message) || reason);
		if (/dynamically imported module|Importing a module script failed|Unable to preload/i.test(message)) recover();
	});
})();`;

/** Called once the app has rendered: later chunk failures notify instead of reloading, and the count starts over. */
export function markAppReady(): void {
	(window as unknown as Record<string, unknown>)[ASSET_RECOVERY_READY_FLAG] = true;
	try {
		sessionStorage.removeItem(ASSET_RELOAD_STORAGE_KEY);
	} catch {
		// Storage can be unavailable; the count then expires with its window.
	}
}
