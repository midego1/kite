/** sessionStorage key counting the automatic reloads of this tab: `{ count, since }`. */
const ASSET_RELOAD_STORAGE_KEY = "kite:asset-reload";
/**
 * Set on `window` by markAppReady(), from UpdateAvailableHost's first effect: the app's first client commit has
 * happened. That is an approximation of "the app works" (a lazy part can still fail later, and the flag can be
 * set while a reload is already waiting), which is why a scheduled reload checks it again when its timer fires.
 */
const ASSET_RECOVERY_READY_FLAG = "__kiteAppReady";
/** Set on `window` by markLoaderMounted(): React has taken over AuthGuard's startup screen (LoadingTransition). */
const LOADER_MOUNTED_FLAG = "__kiteLoaderMounted";
/** The element the script adds to <body> when it gives up: a static "Kite couldn't load" with a Reload button. */
const BOOT_FAILURE_ID = "kite-boot-failure";
/** Visible time the startup screen may stay before the watchdog acts... */
const BOOT_WATCHDOG_MS = 8_000;
/**
 * ...unless the load is still moving: a file the document names has not finished, or one of ours finished within
 * this long (longer under `vite dev`, which compiles each module on request)...
 */
const BOOT_PROGRESS_GRACE_MS = 3_000;
const DEV_BOOT_PROGRESS_GRACE_MS = 10_000;
/** ...and never longer than this, however slowly the files arrive (a cold `vite dev` compiles for longer). */
const BOOT_WATCHDOG_CAP_MS = 20_000;
const DEV_BOOT_WATCHDOG_CAP_MS = 60_000;
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
 *
 * The boot watchdog covers what fires no error. AuthGuard's startup screen (logo and progress bar, see
 * LoadingTransition) is server-rendered; once React takes it over the bar moves and the screen ends or recovers by
 * itself. A request that hangs instead of failing (a chunk, or the document stream), an exception while the entry
 * evaluates, or vinext aborting hydration leave the server's screen up with its bar frozen where it started. So
 * when the screen is still the server's (no LOADER_MOUNTED_FLAG; on a page without the screen, no ready flag)
 * after BOOT_WATCHDOG_MS of visible time, and nothing is loading any more (every script, module preload and
 * stylesheet of ours the document names has a resource entry, and none arrived for BOOT_PROGRESS_GRACE_MS) or
 * BOOT_WATCHDOG_CAP_MS of visible time have passed, it reloads within the same budget as a failed chunk. Hidden time does not count. Once
 * the budget is spent, offline, or without storage, it shows a static "Kite couldn't load" with a Reload button
 * instead (no React; markLoaderMounted() removes it if React starts after all), and coming back online reloads.
 */
export function assetRecoveryScript({ dev = false }: { dev?: boolean } = {}): string {
	const prefixes = dev ? DEV_ASSET_PREFIXES : PRODUCTION_ASSET_PREFIXES;
	const watchdogCapMs = dev ? DEV_BOOT_WATCHDOG_CAP_MS : BOOT_WATCHDOG_CAP_MS;
	const progressGraceMs = dev ? DEV_BOOT_PROGRESS_GRACE_MS : BOOT_PROGRESS_GRACE_MS;
	return `(() => {
	const key = ${JSON.stringify(ASSET_RELOAD_STORAGE_KEY)};
	const readyFlag = ${JSON.stringify(ASSET_RECOVERY_READY_FLAG)};
	const pendingFlag = ${JSON.stringify(STALE_ASSETS_PENDING_FLAG)};
	const delays = ${JSON.stringify(ASSET_RELOAD_DELAYS_MS)};
	const windowMs = ${ASSET_RELOAD_WINDOW_MS};
	const staleGapMs = ${STALE_ASSETS_GAP_MS};
	const prefixes = ${JSON.stringify(prefixes)};
	const loaderFlag = ${JSON.stringify(LOADER_MOUNTED_FLAG)};
	const failureId = ${JSON.stringify(BOOT_FAILURE_ID)};
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
	// The startup screen is still the server's: React has not taken it over (or, without one, not rendered).
	const stalled = () => {
		if (window[loaderFlag]) return false;
		const screen = document.querySelector("[data-loading-overlay]");
		if (screen) return screen.getAttribute("role") === "status";
		return !window[readyFlag];
	};
	const startOver = () => {
		try {
			sessionStorage.removeItem(key);
		} catch {}
		location.reload();
	};
	const showFailure = () => {
		if (!document.body || document.getElementById(failureId)) return;
		const box = document.createElement("div");
		box.id = failureId;
		box.setAttribute("role", "alert");
		box.style.cssText = "position:fixed;left:50%;top:calc(50% + 80px);transform:translateX(-50%);z-index:110;width:18rem;text-align:center;font:14px/1.4 system-ui,sans-serif";
		const text = document.createElement("p");
		text.textContent = "Kite couldn't load.";
		text.style.margin = "0";
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = "Reload";
		button.style.cssText = "margin-top:12px;border:0;border-radius:8px;background:#2563eb;color:#fff;padding:8px 16px;font:inherit;cursor:pointer";
		box.append(text, button);
		document.body.append(box);
	};
	const giveUp = () => {
		if (!gaveUp) console.error("[kite] The app's files could not be loaded after " + delays.length + " reloads.");
		gaveUp = true;
		if (stalled()) showFailure();
	};
	// Counts the reload, or gives up when the budget is spent; false when nothing could stop a loop.
	const takeReload = () => {
		const state = currentState();
		if (state.count >= delays.length) {
			giveUp();
			return false;
		}
		const next = { count: state.count + 1, since: state.since };
		try {
			sessionStorage.setItem(key, JSON.stringify(next));
		} catch {
			return false;
		}
		// Without a stored count nothing would stop a reload loop.
		return readState()?.count === next.count;
	};
	const reloadNow = () => {
		reloadPending = false;
		if (window[readyFlag]) return notifyStale();
		if (takeReload()) location.reload();
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

	let visibleMs = 0;
	let lastProgressAt = Date.now();
	let lastTickAt = Date.now();
	let watchdog = null;
	// A resource entry appears when a request completes, so a file the document names without one is still loading
	// (or hangs: the cap decides then).
	const finished = new Set();
	try {
		new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) {
				if (!isAsset(entry.name)) continue;
				finished.add(entry.name);
				lastProgressAt = Date.now();
			}
		}).observe({ type: "resource", buffered: true });
	} catch {}
	const loading = () => {
		if (Date.now() - lastProgressAt < ${progressGraceMs}) return true;
		for (const element of document.querySelectorAll("script[src], link[href]")) {
			if (element.tagName === "LINK" && !/(^|\\s)(modulepreload|stylesheet)(\\s|$)/i.test(element.rel)) continue;
			const url = element.src || element.href;
			if (isAsset(url) && !finished.has(new URL(url, location.href).href)) return true;
		}
		return false;
	};
	const tick = () => {
		const now = Date.now();
		if (document.visibilityState !== "hidden") visibleMs += Math.min(now - lastTickAt, 1000);
		lastTickAt = now;
		if (!stalled()) return clearInterval(watchdog);
		if (visibleMs < ${BOOT_WATCHDOG_MS}) return;
		if (visibleMs < ${watchdogCapMs} && loading()) return;
		// A failed chunk's reload is already on its way.
		if (reloadPending) return;
		clearInterval(watchdog);
		if (navigator.onLine === false || !takeReload()) return showFailure();
		location.reload();
	};
	watchdog = setInterval(tick, 500);
	// While React hydrates the document it stops clicks below it at its capture listener on document, so a listener
	// on the button would never run. One on window sees them first.
	addEventListener(
		"click",
		(event) => {
			const target = event.target;
			if (target && typeof target.closest === "function" && target.closest("#" + failureId + " button")) startOver();
		},
		true,
	);
	addEventListener("online", () => {
		if (document.getElementById(failureId) && stalled()) startOver();
	});
})();`;
}

/** Whether AuthGuard's server-rendered startup screen is still waiting for React to take it over. */
function serverScreenWaiting(): boolean {
	if (typeof document === "undefined") return false;
	if ((window as unknown as Record<string, unknown>)[LOADER_MOUNTED_FLAG]) return false;
	return document.querySelector("[data-loading-overlay]")?.getAttribute("role") === "status";
}

/** The page is running: the reload count starts over and a "Kite couldn't load" message goes away. */
function clearBootRecovery(): void {
	try {
		sessionStorage.removeItem(ASSET_RELOAD_STORAGE_KEY);
	} catch {
		// Storage can be unavailable; the count then expires with its window.
	}
	if (typeof document !== "undefined") document.getElementById(BOOT_FAILURE_ID)?.remove();
}

/**
 * Called once the app has rendered: later chunk failures notify instead of reloading, and the count starts over,
 * unless the startup screen is still the server's (the root rendered, but the part with the screen did not), so
 * the boot watchdog's budget still holds.
 */
export function markAppReady(): void {
	(window as unknown as Record<string, unknown>)[ASSET_RECOVERY_READY_FLAG] = true;
	if (!serverScreenWaiting()) clearBootRecovery();
}

/** Called by LoadingTransition when it mounts: React runs the startup screen, which ends or recovers by itself. */
export function markLoaderMounted(): void {
	(window as unknown as Record<string, unknown>)[LOADER_MOUNTED_FLAG] = true;
	clearBootRecovery();
}

/** Whether a stale-asset signal arrived that no listener has handled yet; clears it. */
export function takeStaleAssetsSignal(): boolean {
	const target = window as unknown as Record<string, unknown>;
	const pending = target[STALE_ASSETS_PENDING_FLAG] === true;
	delete target[STALE_ASSETS_PENDING_FLAG];
	return pending;
}
