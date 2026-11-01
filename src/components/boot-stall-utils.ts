import { BOOT_HANG_RELOAD_KEY, BOOT_STALLED_EVENT, WORKER_BEAT_GLOBAL } from "./boot-trace-utils";

/*
 * Two parts of the boot watchdog's inline script (assetRecoveryScript in asset-recovery-utils.ts), which pastes them
 * into its own scope: they use its `trace`, `takeReload`, `stopWatching` and `showFailure`.
 */

/**
 * Visible time a start React runs may stay in one boot phase and step (boot-trace-utils.ts) before it counts as
 * stalled. The session check gets longer than its own timeouts and retry (6 + 1 + 4 seconds, then AuthGuard's error
 * state), the data wait longer than LoadingTransition's 10 seconds; the render phases take milliseconds.
 */
const HANG_BUDGETS_MS: Record<string, number> = {
	"loader-mounted": 15_000,
	"auth-answered": 8_000,
	"children-rendering": 8_000,
	"children-committed": 8_000,
	"auth-ready": 15_000,
	"can-complete": 5_000,
};
const HANG_DEFAULT_BUDGET_MS = 15_000;
/** After asking the stuck step to try again, this much more visible time without progress before the one reload. */
const HANG_RETRY_GRACE_MS = 8_000;
/** Visible time without a single animation frame (nothing painted) after which the start counts as stalled. */
const FRAME_STALL_MS = 10_000;
/** After Copy details, this much visible time in which the stall's reload or box waits for whoever is reporting it. */
const COPY_HOLD_MS = 30_000;
/**
 * sessionStorage key of this tab's id, sent with every heartbeat to the service worker's freeze watchdog
 * (public/kite-sw.js): a reload gives the tab a new client id, so the worker limits its reloads per tab by this one.
 */
const TAB_ID_STORAGE_KEY = "kite:tab-id";
/**
 * sessionStorage key of the time the service worker reloaded this tab after a freeze (its own `Date.now()`), kept
 * until a start goes through.
 */
const AUTO_RELOADED_STORAGE_KEY = "kite:auto-reloaded-at";
/** Kite's service worker: notifications and the freeze watchdog. Registered once React runs the startup screen. */
const KITE_SERVICE_WORKER_URL = "/kite-sw.js";

/**
 * A start React runs can also stop moving while the page stays alive: a request that never answers and outlives its
 * own timeout, a render that never commits, a page the browser no longer paints. Its timers still run, so this
 * watchdog keeps its heartbeat, but the startup screen shows nothing new (no progress, no "Reload Kite"). So while
 * React runs the screen, each tick also compares the boot trace's phase and step with the last tick's, and asks for
 * an animation frame. When the phase and step stay the same for their budget (HANG_BUDGETS_MS) of visible time, it
 * first asks the stuck step to try again (BOOT_STALLED_EVENT: the session check aborts and retries); without
 * progress HANG_RETRY_GRACE_MS later, or after FRAME_STALL_MS of visible time without a frame, it records the stall
 * in the boot trace (the step, the reason and the requests still open, which the next load reports) and reloads
 * once, within the same budget as the others. BOOT_HANG_RELOAD_KEY marks that reload until a start completes, so a
 * start that stalls again gets "Kite couldn't load" instead, also when the screen shows its own "Reload Kite".
 *
 * A file of ours still on its way is no stall: while something is loading and has progressed within the boot
 * watchdog's quiet cap, none of that time counts, so a slow link right after a deploy keeps its start (and the file's
 * step then has its whole budget). A file that goes quiet for the cap is a hung request and counts as past the budget
 * at once. Neither the reload nor the box comes while the Details are open or just after Copy details (COPY_HOLD_MS):
 * someone is reading them, with "Reload Kite" in reach.
 *
 * Runs from the watchdog's tick while React runs the startup screen (`watchHang(elapsed)`, visible time only).
 */
export function bootStallScript(): string {
	return `// A start React runs that stopped moving: same phase and step, or no frames, for too long.
	const hangBudgets = ${JSON.stringify(HANG_BUDGETS_MS)};
	let hangKey = null;
	let hangMs = 0;
	let hangRetried = false;
	let hangStalled = false;
	let noFrameMs = 0;
	let frameSeen = true;
	let framePending = false;
	let copyHoldMs = 0;
	const noteDetailsCopied = () => {
		copyHoldMs = ${COPY_HOLD_MS};
	};
	const readingDetails = () => copyHoldMs > 0 || !!document.querySelector("details[open] [data-boot-details]");
	const askFrame = () => {
		if (framePending) return;
		framePending = true;
		try {
			requestAnimationFrame(() => {
				framePending = false;
				frameSeen = true;
			});
		} catch {
			framePending = false;
			frameSeen = true;
		}
	};
	const hangReloaded = () => {
		try {
			return sessionStorage.getItem(${JSON.stringify(BOOT_HANG_RELOAD_KEY)}) !== null;
		} catch {
			return true;
		}
	};
	const watchHang = (elapsed) => {
		const current = trace();
		let status = null;
		try {
			status = current && typeof current.status === "function" ? current.status() : null;
		} catch {}
		const phase = status && typeof status.phase === "string" ? status.phase : "loader-mounted";
		const key = phase + "|" + (status && status.step ? status.step : "");
		const filesLoading = loading();
		const fileHung = filesLoading && quietMs >= quietCap;
		copyHoldMs = Math.max(0, copyHoldMs - elapsed);
		if (key !== hangKey) {
			hangKey = key;
			hangMs = 0;
			hangRetried = false;
		} else if (!filesLoading || fileHung) hangMs += elapsed;
		// Hidden tabs get no frames; a hidden tick counts nothing.
		if (frameSeen || elapsed === 0) noFrameMs = 0;
		else noFrameMs += elapsed;
		frameSeen = false;
		askFrame();
		const budget = hangBudgets[phase] || ${HANG_DEFAULT_BUDGET_MS};
		if (fileHung) hangMs = Math.max(hangMs, budget);
		const noFrames = noFrameMs >= ${FRAME_STALL_MS};
		// Without the trace's phase and step there is no progress to compare, only frames.
		if (!noFrames && (!status || hangMs < budget)) return;
		if (!noFrames && !hangRetried) {
			hangRetried = true;
			console.error("[kite] the start stalled at " + phase + (status && status.step ? " (step " + status.step + ")" : "") + "; trying again");
			try {
				window.dispatchEvent(new Event(${JSON.stringify(BOOT_STALLED_EVENT)}));
			} catch {}
			return;
		}
		if (!noFrames && hangMs < budget + ${HANG_RETRY_GRACE_MS}) return;
		if (hangStalled || readingDetails()) return;
		hangStalled = true;
		const reason = noFrames ? "no-frames" : "no-progress";
		let reloading = false;
		if (!hangReloaded() && navigator.onLine !== false && takeReload(true)) {
			try {
				sessionStorage.setItem(${JSON.stringify(BOOT_HANG_RELOAD_KEY)}, String(Date.now()));
			} catch {}
			reloading = hangReloaded();
		}
		if (current && typeof current.hang === "function") {
			try {
				current.hang(reason, reloading);
			} catch {}
		}
		if (reloading) {
			console.error("[kite] the start stalled (" + reason + "); reloading once");
			stopWatching(false);
			location.reload();
			return;
		}
		console.error("[kite] The app did not finish starting: it stalled (" + reason + ").");
		showFailure(true);
	};`;
}

/**
 * Every tick, and every change of visibility, is also a heartbeat for the service worker's freeze watchdog
 * (public/kite-sw.js) when one controls the page: the tab's id (TAB_ID_STORAGE_KEY), whether it is visible, and
 * the trace's phase, step and times. The worker runs outside this thread, so when a visible tab's heartbeats stop
 * it reloads the tab, which the page itself cannot do once frozen. The heartbeats stop, with a "done" message,
 * when the watchdog stops (the startup screen has gone), and a page leaving by itself says so on pagehide. A load the
 * worker reloaded hears it back and keeps the time (AUTO_RELOADED_STORAGE_KEY) until a start goes through; the next
 * heartbeats carry it, so a worker that lost its memory still reloads a tab once per failed start. On a first visit nothing controls
 * the page yet, so nothing is sent.
 */
export function bootWorkerScript(): string {
	return `// The service worker's freeze watchdog (public/kite-sw.js); nothing here may stop this watchdog either.
	let workers = null;
	try {
		workers = navigator.serviceWorker || null;
	} catch {}
	let tabId = null;
	try {
		tabId = sessionStorage.getItem(${JSON.stringify(TAB_ID_STORAGE_KEY)});
		if (!tabId) {
			const id = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now();
			sessionStorage.setItem(${JSON.stringify(TAB_ID_STORAGE_KEY)}, id);
			// Without a stored id nothing would limit the worker's reloads: it then never reloads.
			tabId = sessionStorage.getItem(${JSON.stringify(TAB_ID_STORAGE_KEY)}) === id ? id : null;
		}
	} catch {
		tabId = null;
	}
	const autoReloadedAt = () => {
		try {
			const at = Number(sessionStorage.getItem(${JSON.stringify(AUTO_RELOADED_STORAGE_KEY)}));
			return Number.isFinite(at) && at > 0 ? at : null;
		} catch {
			return null;
		}
	};
	let workerWatching = !!workers;
	const tellWorker = (message) => {
		try {
			const controller = workers && workers.controller;
			if (controller) controller.postMessage(message);
		} catch {}
	};
	const workerBeat = () => {
		if (!workerWatching) return;
		try {
			const current = trace();
			const status = current && typeof current.status === "function" ? current.status() : null;
			tellWorker(Object.assign({}, status, {
				type: "kite:boot-beat",
				tabId,
				visible: document.visibilityState !== "hidden",
				autoReloadedAt: autoReloadedAt(),
			}));
		} catch {}
	};
	// A start that went through re-arms the worker for this tab (and drops the page's marker of its reload); one that
	// ended otherwise (this watchdog reloads or gives up) only stops being watched.
	const workerDone = (started) => {
		if (!workerWatching) return;
		workerWatching = false;
		if (started) {
			try {
				sessionStorage.removeItem(${JSON.stringify(AUTO_RELOADED_STORAGE_KEY)});
			} catch {}
		}
		tellWorker({ type: started ? "kite:boot-done" : "kite:boot-leaving", tabId });
	};
	if (workers) {
		// The trace beats at once on every phase it reaches, so a report names the phase a load froze in.
		window[${JSON.stringify(WORKER_BEAT_GLOBAL)}] = workerBeat;
		// No beforeunload listener: Chrome then asks the page before every navigation, a frozen one too, which would
		// hold up the worker's reload. A page on its way out (or into the back-forward cache) says so on pagehide;
		// one shown again from that cache beats again with its next tick.
		addEventListener("pagehide", () => tellWorker({ type: "kite:boot-leaving", tabId }));
		try {
			workers.addEventListener("message", (event) => {
				const data = event.data;
				if (!data || data.type !== "kite:auto-reloaded" || typeof data.at !== "number") return;
				try {
					sessionStorage.setItem(${JSON.stringify(AUTO_RELOADED_STORAGE_KEY)}, String(data.at));
				} catch {}
				const current = trace();
				if (current && typeof current.autoReloaded === "function") current.autoReloaded();
				console.warn("[kite] the previous load froze and was reloaded automatically");
			});
		} catch {}
	}`;
}

/** Registers Kite's service worker with the options every caller uses; idempotent in the browser. */
export function registerKiteServiceWorker(container: ServiceWorkerContainer): Promise<ServiceWorkerRegistration> {
	return container.register(KITE_SERVICE_WORKER_URL, { scope: "/", updateViaCache: "none" });
}

/**
 * Registers the service worker for every signed-in tab, not only those with notifications on, so later loads have
 * its freeze watchdog. It has no fetch handler, so it never touches the page's requests. Once installed it takes
 * control of open tabs, so even this load's later heartbeats reach it.
 */
export function ensureFreezeWatchdogWorker(): void {
	try {
		const container = navigator.serviceWorker;
		if (!container || container.controller) return;
		void registerKiteServiceWorker(container).catch(() => undefined);
	} catch {
		// No service workers here (plain http, or turned off): the startup screen's notice stays the way out.
	}
}
