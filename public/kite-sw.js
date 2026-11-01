// Kite's service worker. It deliberately has no fetch handler, so it never sits between the page and the network.
// It does two things:
// - New-mail notifications can carry a Copy code action, and clicking one copies a one-time code or opens the
//   message, even when the tab that received the mail is closed.
// - A backstop for a startup screen whose page stops: while a tab shows the startup screen, its boot watchdog
//   (asset-recovery-utils.ts) posts a heartbeat here about twice a second. A main thread that stopped runs no
//   timer, so the page cannot reload itself, but this worker runs outside that thread: when a visible tab misses
//   its heartbeats for FREEZE_MS, it reloads the tab with WindowClient.navigate() and reports it to
//   /api/boot-report. One reload per failed start: the tab is disarmed until one of its starts goes through
//   (`kite:boot-done`), kept in Cache Storage so a worker the browser stopped and started again still knows, and the
//   page keeps its own marker too. A start that freezes again before that is only reported; the startup screen's
//   "Kite stopped responding" notice is the way out then. Where navigate() is missing (older Safari) nothing happens.
//   A page that is alive but stuck keeps its heartbeat; the boot watchdog in the page handles that itself.
//   Limits: the browser still has to carry out the navigation. Chromium commits it into a tab whose script never
//   yields only once that script ends (as it does a reload from the toolbar), so there the reload lands the moment
//   the thread comes free instead of leaving the app stuck; a page whose timers stopped while the thread still
//   takes tasks is reloaded at once. A tab first loaded before the worker took control is watched from the next
//   heartbeat after it did.
// Served from the site root, so its scope is the whole origin.

/** Visible time without a heartbeat after which a tab on the startup screen counts as frozen. */
const FREEZE_MS = 10_000;
/** How often the watched tabs are checked. */
const CHECK_EVERY_MS = 1_000;
/**
 * A gap this long between two checks means the worker itself was suspended (the computer slept): every watched
 * tab's silence starts over, since its page was suspended too and has not had the chance to beat yet.
 */
const RESUME_GAP_MS = 5_000;
/** Each heartbeat keeps the worker alive this long, so the check after a tab's last heartbeat still runs. */
const HOLD_MS = 30_000;
/** A tab silent this long is no longer watched, whatever its state. */
const WATCH_TTL_MS = 120_000;
/** A disarmed tab whose start never went through is forgotten after this long (it was closed, most likely). */
const DISARM_TTL_MS = 86_400_000;
/** clients.get() asks the browser about the tab; an answer that takes longer than this decides nothing. */
const CLIENT_LOOKUP_MS = 2_000;
const BOOT_REPORT_PATH = "/api/boot-report";
/** Where the disarmed tabs are kept: one JSON response in Cache Storage. */
const STATE_CACHE = "kite-sw-watchdog";
const STATE_KEY = "/kite-sw-watchdog-state";

/**
 * What to do with a watched tab now, from its last heartbeat (`watch`), what the browser says about it (`client`:
 * null when it is gone, otherwise `{ visibilityState, canNavigate }`) and whether this tab was already reloaded
 * during this failed start (`disarmed`, from this worker's state; the page's own marker is `watch.autoReloadedAt`).
 * Pure, so tests/kite-sw.test.mjs can check every answer:
 * - "gone": the tab closed or left; stop watching it.
 * - "hidden": hidden now or at its last heartbeat (timers are throttled there); never reload.
 * - "wait": not silent for FREEZE_MS of visible time yet.
 * - "no-tab": no tab id (sessionStorage unavailable), so nothing could stop a reload loop; never reload.
 * - "already-reloaded": reloaded once already and no start went through since; report only.
 * - "unsupported": the browser has no WindowClient.navigate(); report only.
 * - "reload".
 */
function freezeVerdict(watch, client, now, disarmed) {
	if (!client) return "gone";
	if (client.visibilityState !== "visible" || !watch.visible) return "hidden";
	const silentSince = Math.max(watch.lastBeat, watch.visibleSince || 0);
	if (now - silentSince < FREEZE_MS) return "wait";
	if (!watch.tabId) return "no-tab";
	if (disarmed || typeof watch.autoReloadedAt === "number") return "already-reloaded";
	if (!client.canNavigate) return "unsupported";
	return "reload";
}

/** Tabs on the startup screen, by client id: the facts of their last heartbeat. */
const watches = new Map();
/**
 * Tabs reloaded during a start that has not gone through since, by the tab id the page keeps in sessionStorage (a
 * reload gives the tab a new client id): when it was reloaded.
 */
const disarmed = new Map();
let checking = null;
let lastCheckAt = null;

const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : undefined);
const milliseconds = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0);

/** Reads the disarmed tabs a previous run of this worker kept; nothing on failure. */
async function restoreState() {
	try {
		const cache = await caches.open(STATE_CACHE);
		const response = await cache.match(STATE_KEY);
		const saved = response ? await response.json() : null;
		const now = Date.now();
		for (const [tabId, at] of Object.entries((saved && saved.disarmed) || {})) {
			if (typeof at === "number" && now - at < DISARM_TTL_MS && !disarmed.has(tabId)) disarmed.set(tabId, at);
		}
	} catch {
		// No Cache Storage: the page's own marker still stops a second reload.
	}
}
const restored = restoreState();

let saving = Promise.resolve();
function saveState() {
	const body = JSON.stringify({ disarmed: Object.fromEntries(disarmed) });
	saving = saving
		.then(async () => {
			const cache = await caches.open(STATE_CACHE);
			await cache.put(STATE_KEY, new Response(body, { headers: { "Content-Type": "application/json" } }));
		})
		.catch(() => undefined);
	return saving;
}

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
	// A heartbeat (or done) that arrived while the browser answered wins: the tab is alive.
	if (watches.get(clientId) !== watch) return;
	if (client && client.visibilityState !== "visible") watch.visibleSince = null;
	else if (client && watch.visible && watch.visibleSince === null) watch.visibleSince = now;
	const facts = client ? { visibilityState: client.visibilityState, canNavigate: typeof client.navigate === "function" } : null;
	const verdict = freezeVerdict(watch, facts, now, !!watch.tabId && disarmed.has(watch.tabId));
	if (verdict === "gone") return void watches.delete(clientId);
	if (verdict === "hidden" || verdict === "wait") return;
	watches.delete(clientId);
	if (verdict !== "reload") {
		await report(watch, "freeze_not_reloaded");
		return;
	}
	disarmed.set(watch.tabId, now);
	await saveState();
	await report(watch, "auto_reloaded_after_freeze");
	try {
		await client.navigate(client.url);
	} catch {
		// Refused (the tab left, or is no longer ours): the startup screen's notice is the way out.
	}
}

async function checkAll() {
	await restored;
	while (watches.size > 0) {
		await sleep(CHECK_EVERY_MS);
		const now = Date.now();
		const resumed = lastCheckAt !== null && now - lastCheckAt > RESUME_GAP_MS;
		lastCheckAt = now;
		if (resumed) {
			for (const watch of watches.values()) {
				watch.lastBeat = now;
				if (watch.visibleSince !== null) watch.visibleSince = now;
			}
			continue;
		}
		await Promise.all(Array.from(watches.keys(), (clientId) => check(clientId, now).catch(() => undefined)));
	}
	checking = null;
	lastCheckAt = null;
}

function onWatchdogMessage(event) {
	const data = event.data;
	const source = event.source;
	if (!data || typeof data !== "object" || !source || typeof source.id !== "string") return false;
	const now = Date.now();
	const tabId = text(data.tabId, 64);
	if (data.type === "kite:boot-beat") {
		onHeartbeat(source.id, data, now);
		// A load this worker reloaded learns so from its first heartbeat (the page keeps the marker until it starts).
		const answer = restored.then(() => {
			const reloadedAt = tabId ? disarmed.get(tabId) : undefined;
			if (reloadedAt !== undefined && typeof data.autoReloadedAt !== "number") {
				source.postMessage({ type: "kite:auto-reloaded", at: reloadedAt });
			}
		});
		if (!checking) checking = checkAll();
		event.waitUntil(Promise.all([answer, Promise.race([checking, sleep(HOLD_MS)])]));
		return true;
	}
	// The start went through: the tab is armed again.
	if (data.type === "kite:boot-done") {
		const watch = watches.get(source.id);
		watches.delete(source.id);
		const done = (watch && watch.tabId) || tabId;
		if (done) {
			event.waitUntil(
				restored.then(() => {
					if (disarmed.delete(done)) return saveState();
				}),
			);
		}
		return true;
	}
	// The page leaves by itself, or its own watchdog took over (a reload of its own, or "Kite couldn't load").
	if (data.type === "kite:boot-leaving") {
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
