/** sessionStorage key counting the automatic reloads of this tab: `{ count, since }`. */
const ASSET_RELOAD_STORAGE_KEY = "kite:asset-reload";
/**
 * Set on `window` by markAppReady(), from UpdateAvailableHost's first effect: the app's first client commit has
 * happened. That is an approximation of "the app works" (a lazy part can still fail later, and the flag can be
 * set while a reload is already waiting), which is why a scheduled reload checks it again when its timer fires.
 */
const ASSET_RECOVERY_READY_FLAG = "__kiteAppReady";
/** Fired on `window` when a chunk fails after the app has rendered, so the update check can run at once. */
export const STALE_ASSETS_EVENT = "kite:stale-assets";
/** Set on `window` with the event, so a listener that registers later (before the session is known) still sees it. */
const STALE_ASSETS_PENDING_FLAG = "__kiteStaleAssets";
/** Later failures within this gap send no further STALE_ASSETS_EVENT. */
const STALE_ASSETS_GAP_MS = 30_000;
/** Waits before each automatic reload; their count is the most a tab reloads within the window below. */
const ASSET_RELOAD_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;
const ASSET_RELOAD_WINDOW_MS = 120_000;
/**
 * Where the build's content-hashed files live: vinext puts every chunk, stylesheet and font under
 * `/_next/static/`. `vite dev` serves modules from its own paths instead, which only matter to the e2e suite.
 */
const PRODUCTION_ASSET_PREFIXES = ["/_next/static/"];
const DEV_ASSET_PREFIXES = ["/_next/static/", "/@id/", "/@fs/", "/@vite/", "/node_modules/", "/src/"];

/*
 * Runs in <head> before the app's entry script. The document can name chunks that no longer answer: right after
 * a deploy, while the new version's files reach every location, or in a tab still running the previous version
 * that lazily loads a chunk the deploy removed. They answer 404, and if that hits the entry module the page stays
 * on its server-rendered "Loading" shell. Only Kite's own content-hashed files count (a same-origin URL under one
 * of the prefixes above): a script, module preload or stylesheet element that fails, `vite:preloadError`, or a
 * rejected dynamic import whose message names such a file (Safari names none, so a message without a URL counts).
 * Blocked third-party or extension scripts and offline failures are left alone.
 *
 * Before the app has rendered a failure schedules one reload after a short wait. When the timer fires it checks
 * readiness again (the app may have rendered meanwhile, and then a reload would throw work away) and only then
 * counts the attempt; at most ASSET_RELOAD_DELAYS_MS.length reloads per ASSET_RELOAD_WINDOW_MS, and none without
 * working sessionStorage, since nothing else could stop a loop. After the app has rendered it never reloads: it
 * fires STALE_ASSETS_EVENT, at most once per STALE_ASSETS_GAP_MS, and leaves STALE_ASSETS_PENDING_FLAG set.
 */
export function assetRecoveryScript({ dev = false }: { dev?: boolean } = {}): string {
	const prefixes = dev ? DEV_ASSET_PREFIXES : PRODUCTION_ASSET_PREFIXES;
	return `(() => {
	const key = ${JSON.stringify(ASSET_RELOAD_STORAGE_KEY)};
	const readyFlag = ${JSON.stringify(ASSET_RECOVERY_READY_FLAG)};
	const pendingFlag = ${JSON.stringify(STALE_ASSETS_PENDING_FLAG)};
	const delays = ${JSON.stringify(ASSET_RELOAD_DELAYS_MS)};
	const windowMs = ${ASSET_RELOAD_WINDOW_MS};
	const staleGapMs = ${STALE_ASSETS_GAP_MS};
	const prefixes = ${JSON.stringify(prefixes)};
	let reloadPending = false;
	let gaveUp = false;
	let lastStaleAt = null;
	const isAsset = (url) => {
		try {
			const parsed = new URL(url, location.href);
			return parsed.origin === location.origin && prefixes.some((prefix) => parsed.pathname.startsWith(prefix));
		} catch {
			return false;
		}
	};
	// A message that names a file must name one of ours; one that names none (Safari) counts.
	const messageNamesAsset = (message) => {
		const match = /https?:\\/\\/[^\\s'"()]+/.exec(message) || /(?:^|\\s)(\\/[^\\s'"()]+)/.exec(message);
		return !match || isAsset(match[1] || match[0]);
	};
	const readState = () => {
		try {
			const state = JSON.parse(sessionStorage.getItem(key) || "null");
			return state && typeof state.count === "number" && typeof state.since === "number" ? state : null;
		} catch {
			return null;
		}
	};
	const currentState = () => {
		const now = Date.now();
		const state = readState();
		return !state || now - state.since > windowMs || state.since > now ? { count: 0, since: now } : state;
	};
	const notifyStale = () => {
		const now = Date.now();
		if (lastStaleAt !== null && now - lastStaleAt < staleGapMs) return;
		lastStaleAt = now;
		window[pendingFlag] = true;
		window.dispatchEvent(new Event(${JSON.stringify(STALE_ASSETS_EVENT)}));
	};
	const giveUp = () => {
		if (!gaveUp) console.error("[kite] The app's files could not be loaded after " + delays.length + " reloads.");
		gaveUp = true;
	};
	const reloadNow = () => {
		reloadPending = false;
		if (window[readyFlag]) return notifyStale();
		const state = currentState();
		if (state.count >= delays.length) return giveUp();
		const next = { count: state.count + 1, since: state.since };
		try {
			sessionStorage.setItem(key, JSON.stringify(next));
		} catch {
			return;
		}
		// Without a stored count nothing would stop a reload loop.
		if (readState()?.count !== next.count) return;
		location.reload();
	};
	const recover = () => {
		if (navigator.onLine === false) return;
		if (window[readyFlag]) return notifyStale();
		if (reloadPending || gaveUp) return;
		const state = currentState();
		if (state.count >= delays.length) return giveUp();
		reloadPending = true;
		setTimeout(reloadNow, delays[state.count]);
	};
	addEventListener(
		"error",
		(event) => {
			const target = event.target;
			if (target instanceof HTMLScriptElement) {
				if (target.src && isAsset(target.src)) recover();
			} else if (target instanceof HTMLLinkElement) {
				if (/(^|\\s)(modulepreload|stylesheet)(\\s|$)/i.test(target.rel) && isAsset(target.href)) recover();
			}
		},
		true,
	);
	const messageOf = (reason) => String((reason && reason.message) || reason || "");
	addEventListener("vite:preloadError", (event) => {
		if (messageNamesAsset(messageOf(event.payload))) recover();
	});
	addEventListener("unhandledrejection", (event) => {
		const message = messageOf(event.reason);
		if (/dynamically imported module|Importing a module script failed|Unable to preload/i.test(message) && messageNamesAsset(message)) {
			recover();
		}
	});
})();`;
}

/** Called once the app has rendered: later chunk failures notify instead of reloading, and the count starts over. */
export function markAppReady(): void {
	(window as unknown as Record<string, unknown>)[ASSET_RECOVERY_READY_FLAG] = true;
	try {
		sessionStorage.removeItem(ASSET_RELOAD_STORAGE_KEY);
	} catch {
		// Storage can be unavailable; the count then expires with its window.
	}
}

/** Whether a stale-asset signal arrived that no listener has handled yet; clears it. */
export function takeStaleAssetsSignal(): boolean {
	const target = window as unknown as Record<string, unknown>;
	const pending = target[STALE_ASSETS_PENDING_FLAG] === true;
	delete target[STALE_ASSETS_PENDING_FLAG];
	return pending;
}
