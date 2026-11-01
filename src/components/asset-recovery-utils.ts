import { BOOT_TRACE_GLOBAL, bootCopyLabel, markBootPhase } from "./boot-trace-utils";
import { bootStallScript, bootWorkerScript, ensureFreezeWatchdogWorker } from "./boot-stall-utils";

/**
 * sessionStorage key counting the automatic reloads of this tab: `{ count, since, stalls }`, where `stalls` counts
 * the boot watchdog's share of `count`.
 */
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
/** Visible time the startup screen may stay before the watchdog acts. */
const BOOT_WATCHDOG_MS = 8_000;
/**
 * With nothing left loading, the watchdog acts once the last of our files is this old (longer under `vite dev`,
 * which compiles each module on request).
 */
const BOOT_PROGRESS_GRACE_MS = 3_000;
const DEV_BOOT_PROGRESS_GRACE_MS = 10_000;
/**
 * While something is still loading (a file the document names has not finished, or the document itself is still
 * streaming), it waits as long as anything arrives and acts only after this long without progress: a hung request.
 */
const BOOT_QUIET_CAP_MS = 20_000;
const DEV_BOOT_QUIET_CAP_MS = 30_000;
/**
 * After a watchdog reload in this window the silence is a repeat, not a slow first load: act sooner, so a hang that
 * survives the reloads reaches "Kite couldn't load" in about 20 + 11 + 11 seconds.
 */
const BOOT_REPEAT_QUIET_CAP_MS = 10_000;
const DEV_BOOT_REPEAT_QUIET_CAP_MS = 15_000;
/** However the load moves, the watchdog acts after this much visible time. */
const BOOT_WATCHDOG_CEILING_MS = 60_000;
const DEV_BOOT_WATCHDOG_CEILING_MS = 120_000;
/**
 * Visible time after which a startup screen React runs but never ends (nor replaces with its own recovery) gets
 * the static "Kite couldn't load" too: the outer bound for whatever keeps the app from finishing its start.
 */
const LOADER_CEILING_MS = 30_000;
/** Marks the failure box shown for a screen React runs, which markLoaderMounted() leaves in place. */
const LOADER_STUCK_ATTRIBUTE = "data-loader-stuck";
/**
 * A startup screen whose element React replaced this often (a remount loop) counts as stuck even while it shows
 * its own "Reload Kite", which a remount takes away again.
 */
const LOADER_REMOUNT_LIMIT = 3;
/**
 * Ticks the screen must stay down (gone, or hidden without a failure in it) before the watchdog stops for good: a
 * failure with Retry puts the same screen back, and the outer bound must still hold then.
 */
const LOADER_SETTLED_TICKS = 4;
/**
 * Flipped between "a" and "b" on <html> on every watchdog tick: each flip restarts the animation that reveals the
 * startup screen's frozen-thread notice (`.loader-frozen` in globals.css), so it only shows once the ticks stop.
 */
const HEARTBEAT_ATTRIBUTE = "data-kite-heartbeat";
/** On <html> while the tab is hidden: ticks are throttled there, so the notice's animation is paused. */
const HIDDEN_ATTRIBUTE = "data-kite-hidden";
/** Watchdog reloads per ASSET_RELOAD_WINDOW_MS (within the shared budget) before it shows "Kite couldn't load". */
const BOOT_STALL_RELOADS = 2;
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
 * after BOOT_WATCHDOG_MS of visible time (hidden time does not count), it reloads within the same budget as a
 * failed chunk, as soon as either:
 * - nothing is loading any more (every script, module preload and stylesheet of ours the document names has a
 *   resource entry, the document has been parsed) and the last progress is BOOT_PROGRESS_GRACE_MS old, or
 * - something is still loading but nothing progressed for BOOT_QUIET_CAP_MS (BOOT_REPEAT_QUIET_CAP_MS after a
 *   watchdog reload within the window), counted in visible time like the rest. Progress is one of our files
 *   finishing (a resource entry appears only when a request completes, so a hung one goes quiet) or the parser
 *   adding nodes while the document streams in, so a slow load that keeps moving is never cut short, or
 * - BOOT_WATCHDOG_CEILING_MS of visible time have passed regardless.
 * After BOOT_STALL_RELOADS watchdog reloads, once the budget is spent, offline, or without storage, it shows a
 * static "Kite couldn't load" with a Reload button instead (no React; markLoaderMounted() removes it if React starts
 * after all), and coming back online reloads.
 *
 * Once React runs the screen the watchdog does not reload any more, but it keeps the outer bound: when the screen
 * is still up after LOADER_CEILING_MS of visible time and React shows none of its own ways out (the slow-start
 * recovery, a failure in the screen), it shows the same "Kite couldn't load" box, marked LOADER_STUCK_ATTRIBUTE so a
 * remounting screen cannot take it away; the box goes once the screen does. A screen whose element was replaced
 * LOADER_REMOUNT_LIMIT times is stuck even with its own recovery showing (a remount loop keeps resetting it). A
 * failure in the screen restarts the bound (its Retry brings the screen back), and the watchdog only stops once
 * the screen has stayed down for LOADER_SETTLED_TICKS ticks. Nothing (a remount loop, a state that never settles,
 * the kite's return scene) can then keep the app hidden behind the screen for good.
 *
 * Every tick is a heartbeat for the boot trace (boot-trace-utils.ts), which a frozen main thread stops, and the
 * box carries the trace's Details with a Copy details button. Every tick also restarts the animation of the startup
 * screen's frozen-thread notice (HEARTBEAT_ATTRIBUTE): a main thread that stopped runs neither the slow-start
 * recovery nor this watchdog, but the compositor still fades that notice in once the ticks have stopped.
 *
 * The stall detection and the service worker's heartbeat are in boot-stall-utils.ts.
 */
export function assetRecoveryScript({ dev = false }: { dev?: boolean } = {}): string {
	const prefixes = dev ? DEV_ASSET_PREFIXES : PRODUCTION_ASSET_PREFIXES;
	const progressGraceMs = dev ? DEV_BOOT_PROGRESS_GRACE_MS : BOOT_PROGRESS_GRACE_MS;
	const quietCapMs = dev ? DEV_BOOT_QUIET_CAP_MS : BOOT_QUIET_CAP_MS;
	const repeatQuietCapMs = dev ? DEV_BOOT_REPEAT_QUIET_CAP_MS : BOOT_REPEAT_QUIET_CAP_MS;
	const ceilingMs = dev ? DEV_BOOT_WATCHDOG_CEILING_MS : BOOT_WATCHDOG_CEILING_MS;
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
	const trace = () => window[${JSON.stringify(BOOT_TRACE_GLOBAL)}] || null;
	// The frozen-thread notice (globals.css) starts over on every beat; once the beats stop it shows by itself.
	const root = document.documentElement;
	// Cosmetic: nothing here may stop the watchdog.
	const heartbeat = () => {
		try {
			root.setAttribute(${JSON.stringify(HEARTBEAT_ATTRIBUTE)}, root.getAttribute(${JSON.stringify(HEARTBEAT_ATTRIBUTE)}) === "a" ? "b" : "a");
		} catch {}
	};
	${bootWorkerScript()}
	const followVisibility = () => {
		try {
			if (document.visibilityState === "hidden") return root.setAttribute(${JSON.stringify(HIDDEN_ATTRIBUTE)}, "");
			root.removeAttribute(${JSON.stringify(HIDDEN_ATTRIBUTE)});
		} catch {}
		heartbeat();
	};
	followVisibility();
	workerBeat();
	addEventListener("visibilitychange", () => {
		followVisibility();
		workerBeat();
	});
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
	// React runs the startup screen and it is still up, without a way out of its own (or its element keeps being
	// replaced, which takes that way out away again).
	let overlay = null;
	let remounts = 0;
	const loaderStuck = () => {
		const screen = document.querySelector("[data-loading-overlay]");
		if (!screen || screen.getAttribute("role") !== "status") return false;
		// A start that stalled has no way out on its screen any more, whatever it shows.
		if (hangStalled || remounts >= ${LOADER_REMOUNT_LIMIT}) return true;
		return !screen.querySelector(".loading-recovery, [role=alert]");
	};
	const startOver = () => {
		try {
			sessionStorage.removeItem(key);
		} catch {}
		location.reload();
	};
	const showFailure = (stuck = false) => {
		const parent = document.body || document.documentElement;
		if (!parent || document.getElementById(failureId)) return;
		const box = document.createElement("div");
		box.id = failureId;
		box.setAttribute("role", "alert");
		if (stuck) box.setAttribute(${JSON.stringify(LOADER_STUCK_ATTRIBUTE)}, "");
		box.style.cssText = "position:fixed;left:50%;top:calc(50% + 80px);transform:translateX(-50%);z-index:110;width:18rem;text-align:center;font:14px/1.4 system-ui,sans-serif";
		const text = document.createElement("p");
		text.textContent = "Kite couldn't load.";
		text.style.margin = "0";
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = "Reload";
		button.setAttribute("data-boot-reload", "");
		button.style.cssText = "margin-top:12px;border:0;border-radius:8px;background:#2563eb;color:#fff;padding:8px 16px;font:inherit;cursor:pointer";
		box.append(text, button);
		const details = detailsSection();
		if (details) box.append(details);
		parent.append(box);
		button.focus();
	};
	// What the boot trace knows, folded away: for a report, never needed to get going again.
	const detailsSection = () => {
		const current = trace();
		if (!current || typeof current.text !== "function") return null;
		try {
			const section = document.createElement("details");
			section.style.cssText = "margin-top:12px;text-align:left;font-size:12px;opacity:0.8";
			const summary = document.createElement("summary");
			summary.textContent = "Details";
			summary.style.cssText = "cursor:pointer;text-align:center";
			const lines = document.createElement("pre");
			lines.setAttribute("data-boot-details", "");
			lines.textContent = current.text();
			lines.style.cssText = "margin:8px 0 0;max-height:12rem;overflow:auto;white-space:pre-wrap;word-break:break-word;font:11px/1.4 ui-monospace,monospace";
			const copy = document.createElement("button");
			copy.type = "button";
			copy.textContent = "Copy details";
			copy.setAttribute("data-boot-copy", "");
			copy.style.cssText = "margin-top:8px;border:1px solid #d4d4d4;border-radius:6px;background:transparent;color:inherit;padding:4px 10px;font:inherit;cursor:pointer";
			section.append(summary, lines, copy);
			// Opened later, it shows the trace as it is then.
			section.addEventListener("toggle", () => {
				if (section.open) lines.textContent = current.text();
			});
			return section;
		} catch {
			return null;
		}
	};
	const copyDetails = (button) => {
		const current = trace();
		if (!current || typeof current.copy !== "function") return;
		const box = document.getElementById(failureId);
		current.copy(box && box.querySelector("[data-boot-details]")).then((result) => {
			button.textContent = ${JSON.stringify(Object.fromEntries((["copied", "selected", "failed"] as const).map((result) => [result, bootCopyLabel(result)])))}[result] || "Copy details";
		});
	};
	const giveUp = (message = "[kite] The app's files could not be loaded after " + delays.length + " reloads.") => {
		if (!gaveUp) console.error(message);
		gaveUp = true;
		if (stalled()) showFailure();
	};
	// Counts the reload (\`stall\`: the watchdog's), or gives up when its budget is spent; false when nothing could
	// stop a loop.
	const takeReload = (stall) => {
		const state = currentState();
		const stalls = state.stalls || 0;
		if (state.count >= delays.length) {
			giveUp();
			return false;
		}
		if (stall && stalls >= ${BOOT_STALL_RELOADS}) {
			giveUp("[kite] The app did not start after " + stalls + " automatic reloads.");
			return false;
		}
		const next = { count: state.count + 1, since: state.since, stalls: stalls + (stall ? 1 : 0) };
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
		if (takeReload(false)) location.reload();
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

	const quietCap = currentState().stalls > 0 ? ${repeatQuietCapMs} : ${quietCapMs};
	// Both count visible time tick by tick, at most a second per tick: a frozen or hidden page (an app switch on
	// iOS, a background tab Chrome or Android froze) must not wake up to 20 seconds of "quiet" and reload at once.
	let visibleMs = 0;
	let quietMs = 0;
	// Visible time since the page started or React's last failure in the screen (whose Retry brings it back).
	let loaderMs = 0;
	let lastTickAt = Date.now();
	let watchdog = null;
	const progressed = () => {
		quietMs = 0;
	};
	// A resource entry appears when a request completes, so a file the document names without one is still loading
	// (or hangs: the quiet cap decides then).
	const finished = new Set();
	try {
		new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) {
				if (!isAsset(entry.name)) continue;
				finished.add(entry.name);
				progressed();
			}
		}).observe({ type: "resource", buffered: true });
	} catch {}
	// While the document streams in, every node the parser adds is progress; a stream that stops goes quiet.
	try {
		const parsing = new MutationObserver(progressed);
		parsing.observe(document, { childList: true, subtree: true });
		addEventListener("DOMContentLoaded", () => parsing.disconnect());
	} catch {}
	const loading = () => {
		if (document.readyState === "loading") return true;
		for (const element of document.querySelectorAll("script[src], link[href]")) {
			if (element.tagName === "LINK" && !/(^|\\s)(modulepreload|stylesheet)(\\s|$)/i.test(element.rel)) continue;
			const url = element.src || element.href;
			if (isAsset(url) && !finished.has(new URL(url, location.href).href)) return true;
		}
		return false;
	};
	// The watchdog is done with this page (\`started\`: because the start went through): the trace's heartbeat stops
	// with it, which is no freeze.
	const stopWatching = (started) => {
		clearInterval(watchdog);
		workerDone(started);
		const current = trace();
		if (current && typeof current.end === "function") current.end();
	};
	${bootStallScript()}
	// React runs the screen: no more reloads, only the outer bound, until the screen has gone for good.
	let settledTicks = 0;
	const watchLoader = (elapsed) => {
		const screen = document.querySelector("[data-loading-overlay]");
		if (!screen || screen.getAttribute("role") !== "status") {
			const box = document.getElementById(failureId);
			if (box && box.hasAttribute(${JSON.stringify(LOADER_STUCK_ATTRIBUTE)})) box.remove();
			if (!screen && !window[readyFlag]) return;
			// React's own failure is up: its Retry brings the screen back, which then gets a bound of its own.
			if (screen && screen.querySelector("[role=alert]")) {
				loaderMs = 0;
				settledTicks = 0;
				hangKey = null;
				return;
			}
			settledTicks += 1;
			if (settledTicks >= ${LOADER_SETTLED_TICKS}) stopWatching(!hangStalled);
			return;
		}
		settledTicks = 0;
		if (overlay && overlay !== screen) {
			remounts += 1;
			const current = trace();
			if (current && typeof current.remount === "function") current.remount(remounts);
		}
		overlay = screen;
		watchHang(elapsed);
		if (hangStalled && !document.getElementById(failureId)) return;
		if (!hangStalled && (loaderMs < ${LOADER_CEILING_MS} || !loaderStuck())) return;
		if (!document.getElementById(failureId)) {
			console.error(
				remounts >= ${LOADER_REMOUNT_LIMIT}
					? "[kite] The app did not finish starting: its startup screen was mounted again " + remounts + " times."
					: "[kite] The app did not finish starting.",
			);
		}
		showFailure(true);
	};
	const tick = () => {
		heartbeat();
		const now = Date.now();
		let elapsed = 0;
		if (document.visibilityState !== "hidden") {
			elapsed = Math.min(Math.max(now - lastTickAt, 0), 1000);
			visibleMs += elapsed;
			quietMs += elapsed;
			loaderMs += elapsed;
		}
		lastTickAt = now;
		const current = trace();
		if (current && typeof current.beat === "function") current.beat(visibleMs);
		workerBeat();
		if (window[loaderFlag]) return watchLoader(elapsed);
		if (!stalled()) return stopWatching(true);
		if (visibleMs < ${BOOT_WATCHDOG_MS}) return;
		const waiting = quietMs < (loading() ? quietCap : ${progressGraceMs});
		if (waiting && visibleMs < ${ceilingMs}) return;
		// A failed chunk's reload is already on its way.
		if (reloadPending) return;
		stopWatching(false);
		if (navigator.onLine === false || !takeReload(true)) return showFailure();
		location.reload();
	};
	watchdog = setInterval(tick, 500);
	// While React hydrates the document it stops clicks below it at its capture listener on document, so a listener
	// on the button would never run. One on window sees them first.
	addEventListener(
		"click",
		(event) => {
			const target = event.target;
			if (!target || typeof target.closest !== "function") return;
			if (target.closest("#" + failureId + " [data-boot-reload]")) startOver();
			const copy = target.closest("#" + failureId + " [data-boot-copy]");
			if (copy) copyDetails(copy);
			if (target.closest("[data-boot-copy]")) noteDetailsCopied();
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
	if (typeof document === "undefined") return;
	const box = document.getElementById(BOOT_FAILURE_ID);
	// The box for a screen React runs but never ends stays until that screen has gone (the watchdog removes it).
	if (box && !box.hasAttribute(LOADER_STUCK_ATTRIBUTE)) box.remove();
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
	markBootPhase("loader-mounted");
	clearBootRecovery();
	ensureFreezeWatchdogWorker();
}

/** Whether a stale-asset signal arrived that no listener has handled yet; clears it. */
export function takeStaleAssetsSignal(): boolean {
	const target = window as unknown as Record<string, unknown>;
	const pending = target[STALE_ASSETS_PENDING_FLAG] === true;
	delete target[STALE_ASSETS_PENDING_FLAG];
	return pending;
}
