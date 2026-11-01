// Kite's service worker. It deliberately has no fetch handler, so it never sits between the page and the network.
// It does two things:
// - New-mail notifications can carry a Copy code action, and clicking one copies a one-time code or opens the
//   message, even when the tab that received the mail is closed.
// - The startup freeze watchdog: while a tab shows the startup screen, its boot watchdog (asset-recovery-utils.ts)
//   posts a heartbeat here about twice a second. A main thread that froze runs no timer, so the page cannot reload
//   itself, but this worker runs outside that thread: when a visible tab misses its heartbeats for FREEZE_MS, it
//   reloads the tab with WindowClient.navigate(), at most once per tab per RELOAD_GAP_MS, and reports it to
//   /api/boot-report. A second freeze within that gap is only reported; the startup screen's own "Kite stopped
//   responding" notice is the way out then. Where navigate() is missing (older Safari) nothing happens.
//   Limits: the browser still has to carry out the navigation. Chromium commits it into a tab whose script never
//   yields only once that script ends (as it does a reload from the toolbar), so there the reload lands the moment
//   the thread comes free instead of leaving the app stuck; a page whose timers stopped while the thread still
//   takes tasks is reloaded at once. A tab first loaded before the worker took control is watched from the next
//   heartbeat after it did.
// Served from the site root, so its scope is the whole origin.

/** Visible time without a heartbeat after which a tab on the startup screen counts as frozen. */
const FREEZE_MS = 10_000;
/** At most one automatic reload per tab in this window; a freeze within it after one is only reported. */
const RELOAD_GAP_MS = 120_000;
/** How often the watched tabs are checked. */
const CHECK_EVERY_MS = 1_000;
/** Each heartbeat keeps the worker alive this long, so the check after a tab's last heartbeat still runs. */
const HOLD_MS = 30_000;
/** A tab silent this long is no longer watched, whatever its state. */
const WATCH_TTL_MS = 120_000;
/** clients.get() asks the browser about the tab; an answer that takes longer than this decides nothing. */
const CLIENT_LOOKUP_MS = 2_000;
const BOOT_REPORT_PATH = "/api/boot-report";

/**
 * What to do with a watched tab now, from its last heartbeat (`watch`), what the browser says about it (`client`:
 * null when it is gone, otherwise `{ visibilityState, canNavigate }`) and when this tab was last reloaded (from this
 * worker's memory or the page's own marker). Pure, so tests/kite-sw.test.mjs can check every answer:
 * - "gone": the tab closed or left; stop watching it.
 * - "hidden": hidden now or at its last heartbeat (timers are throttled there); never reload.
 * - "wait": not silent for FREEZE_MS of visible time yet.
 * - "no-tab": no tab id (sessionStorage unavailable), so nothing could stop a reload loop; never reload.
 * - "recently-reloaded": already reloaded automatically within RELOAD_GAP_MS; report only.
 * - "unsupported": the browser has no WindowClient.navigate(); report only.
 * - "reload".
 */
function freezeVerdict(watch, client, now, lastReloadAt) {
	if (!client) return "gone";
	if (client.visibilityState !== "visible" || !watch.visible) return "hidden";
	const silentSince = Math.max(watch.lastBeat, watch.visibleSince || 0);
	if (now - silentSince < FREEZE_MS) return "wait";
	if (!watch.tabId) return "no-tab";
	const reloads = [lastReloadAt, watch.autoReloadedAt].filter((at) => typeof at === "number" && Number.isFinite(at));
	// A time ahead of the clock is no recent reload; one within the gap is.
	if (reloads.some((at) => at <= now && now - at < RELOAD_GAP_MS)) return "recently-reloaded";
	if (!client.canNavigate) return "unsupported";
	return "reload";
}

/** Tabs on the startup screen, by client id: the facts of their last heartbeat. */
const watches = new Map();
/** Automatic reloads, by the tab id the page keeps in sessionStorage (a reload gives the tab a new client id). */
const reloads = new Map();
let checking = null;

const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : undefined);
const milliseconds = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0);

function onHeartbeat(clientId, data, now) {
	const previous = watches.get(clientId);
	const visible = data.visible === true;
	watches.set(clientId, {
		tabId: text(data.tabId, 64) || null,
		lastBeat: now,
		visible,
		visibleSince: visible ? (previous && previous.visibleSince) || now : null,
		autoReloadedAt: typeof data.autoReloadedAt === "number" ? data.autoReloadedAt : null,
		page: text(data.page, 41) || "/",
		phase: text(data.phase, 40) || "inline",
		step: text(data.step, 40),
		build: text(data.build, 60),
		afterMs: milliseconds(data.afterMs),
		visibleMs: milliseconds(data.visibleMs),
	});
}

function report(watch, event) {
	const body = { event, page: watch.page, phase: watch.phase, afterMs: watch.afterMs, visibleMs: watch.visibleMs };
	if (watch.step) body.step = watch.step;
	if (watch.build) body.build = watch.build;
	return fetch(BOOT_REPORT_PATH, {
		method: "POST",
		credentials: "same-origin",
		headers: { "Content-Type": "text/plain" },
		body: JSON.stringify(body),
		keepalive: true,
	}).catch(() => undefined);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function lookUp(clientId) {
	const found = await Promise.race([self.clients.get(clientId).then((client) => client || null), sleep(CLIENT_LOOKUP_MS)]);
	if (found === undefined) return undefined;
	return found;
}

async function check(clientId, now) {
	const watch = watches.get(clientId);
	if (!watch) return;
	if (now - watch.lastBeat > WATCH_TTL_MS) return void watches.delete(clientId);
	const client = await lookUp(clientId);
	// The browser did not answer in time: decide nothing this round.
	if (client === undefined) return;
	if (client && client.visibilityState !== "visible") watch.visibleSince = null;
	else if (client && watch.visible && watch.visibleSince === null) watch.visibleSince = now;
	const facts = client ? { visibilityState: client.visibilityState, canNavigate: typeof client.navigate === "function" } : null;
	const verdict = freezeVerdict(watch, facts, now, watch.tabId ? reloads.get(watch.tabId) : undefined);
	if (verdict === "gone") return void watches.delete(clientId);
	if (verdict === "hidden" || verdict === "wait") return;
	watches.delete(clientId);
	if (verdict !== "reload") {
		await report(watch, "freeze_not_reloaded");
		return;
	}
	reloads.set(watch.tabId, now);
	await report(watch, "auto_reloaded_after_freeze");
	try {
		await client.navigate(client.url);
	} catch {
		// Refused (the tab left, or is no longer ours): the startup screen's notice is the way out.
	}
}

async function checkAll() {
	while (watches.size > 0) {
		await sleep(CHECK_EVERY_MS);
		const now = Date.now();
		await Promise.all(Array.from(watches.keys(), (clientId) => check(clientId, now).catch(() => undefined)));
	}
	checking = null;
}

function onWatchdogMessage(event) {
	const data = event.data;
	const source = event.source;
	if (!data || typeof data !== "object" || !source || typeof source.id !== "string") return false;
	const now = Date.now();
	if (data.type === "kite:boot-beat") {
		onHeartbeat(source.id, data, now);
		// A load this worker reloaded learns so from its first heartbeat (the page keeps the marker for its trace).
		const tabId = text(data.tabId, 64);
		const reloadedAt = tabId ? reloads.get(tabId) : undefined;
		if (reloadedAt !== undefined && data.autoReloadedAt !== reloadedAt && now - reloadedAt < RELOAD_GAP_MS) {
			source.postMessage({ type: "kite:auto-reloaded", at: reloadedAt });
		}
		if (!checking) checking = checkAll();
		event.waitUntil(Promise.race([checking, sleep(HOLD_MS)]));
		return true;
	}
	// The startup screen has gone, or the page is leaving by itself.
	if (data.type === "kite:boot-done" || data.type === "kite:boot-leaving") {
		watches.delete(source.id);
		return true;
	}
	return false;
}

self.addEventListener("install", () => {
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(self.clients.claim());
});

self.addEventListener("message", onWatchdogMessage);

self.addEventListener("notificationclick", (event) => {
	const data = event.notification.data || {};
	const code = typeof data.code === "string" ? data.code : null;
	const messageId = typeof data.messageId === "string" ? data.messageId : null;
	// Browsers without action buttons (Safari, Firefox on desktop) still get the
	// copy on a plain click, because copyOnClick is set for every code notification.
	const copyRequested = !!code && (event.action === "copy" || data.copyOnClick === true);
	event.notification.close();
	event.waitUntil(
		(async () => {
			const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
			let client = windows.find((entry) => entry.url.startsWith(self.registration.scope)) || null;
			if (client) {
				try {
					await client.focus();
				} catch {
					// Focus can be refused; still try to deliver the message.
				}
			} else {
				client = await self.clients.openWindow("/");
			}
			if (!client) return;
			if (copyRequested) client.postMessage({ type: "kite:copy-code", code });
			else if (messageId) client.postMessage({ type: "kite:open-message", messageId });
		})(),
	);
});
