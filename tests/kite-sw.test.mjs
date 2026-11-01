import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "public/kite-sw.js"), "utf8");

/**
 * The service worker in a sandbox with a virtual clock: `advance(ms)` runs its timers in order, `tabs` are the
 * window clients the browser knows (`{ url, visibilityState, navigate? }`), `navigations` and `reports` record what
 * it did, and `beat(clientId, data)` posts a heartbeat from that tab.
 */
function loadWorker({ navigate = true, cacheStore = new Map(), lookupDelayMs = 0 } = {}) {
	const clock = { now: 1_000_000 };
	let timers = [];
	let nextTimer = 0;
	const listeners = new Map();
	const tabs = new Map();
	const navigations = [];
	const reports = [];
	const received = [];
	const held = [];
	const sandbox = {
		Date: { now: () => clock.now },
		setTimeout: (callback, ms) => {
			timers.push({ id: ++nextTimer, at: clock.now + ms, callback });
			return nextTimer;
		},
		clearTimeout: (id) => {
			timers = timers.filter((timer) => timer.id !== id);
		},
		caches: {
			open: async () => ({
				match: async (key) => (cacheStore.has(key) ? { json: async () => JSON.parse(cacheStore.get(key)) } : undefined),
				put: async (key, response) => cacheStore.set(key, response.body),
			}),
		},
		Response: class {
			constructor(body) {
				this.body = body;
			}
		},
		fetch: async (url, init) => {
			reports.push({ url, body: JSON.parse(init.body), credentials: init.credentials });
			return { status: 204 };
		},
		self: {
			addEventListener: (type, listener) => listeners.set(type, listener),
			skipWaiting: () => undefined,
			registration: { scope: "https://mail.example.com/" },
			clients: {
				claim: async () => undefined,
				get: async (id) => {
					if (lookupDelayMs) await new Promise((resolve) => sandbox.setTimeout(resolve, lookupDelayMs));
					const tab = tabs.get(id);
					if (!tab) return undefined;
					const client = { id, url: tab.url, visibilityState: tab.visibilityState };
					if (navigate)
						client.navigate = async (url) => {
							navigations.push({ id, url });
							tabs.delete(id);
							return null;
						};
					return client;
				},
			},
		},
	};
	vm.createContext(sandbox);
	vm.runInContext(source, sandbox);
	const flush = async () => {
		for (let i = 0; i < 20; i += 1) await Promise.resolve();
	};
	const advance = async (ms) => {
		const end = clock.now + ms;
		for (;;) {
			await flush();
			timers.sort((a, b) => a.at - b.at || a.id - b.id);
			const due = timers[0];
			if (!due || due.at > end) break;
			timers.shift();
			clock.now = due.at;
			due.callback();
		}
		clock.now = end;
		await flush();
	};
	const post = (clientId, data) =>
		listeners.get("message")({
			data,
			source: { id: clientId, postMessage: (message) => received.push({ clientId, message }) },
			waitUntil: (promise) => held.push(promise),
		});
	/** Heartbeats every 500 ms for `ms`, as the boot watchdog's ticks send them. */
	const beatFor = async (clientId, ms, data) => {
		for (let at = 0; at < ms; at += 500) {
			post(clientId, { type: "kite:boot-beat", ...data });
			await advance(500);
		}
	};
	/** The computer sleeps for `ms`: the clock moves on, but no timer of the worker runs meanwhile. */
	const suspend = (ms) => {
		clock.now += ms;
		for (const timer of timers) timer.at += ms;
	};
	return { sandbox, clock, tabs, navigations, reports, received, held, cacheStore, advance, post, beatFor, suspend };
}

const BEAT = {
	tabId: "tab-1",
	visible: true,
	page: "/inbox",
	phase: "loader-mounted",
	step: "mailbox-shell",
	build: "2026.11.01.3 (abc1234)",
	afterMs: 950,
	visibleMs: 900,
	autoReloadedAt: null,
};

test("the verdict reloads only a visible tab that stayed silent long enough, once per failed start", () => {
	const { sandbox } = loadWorker();
	const verdict = sandbox.freezeVerdict;
	const now = 500_000;
	const watch = {
		tabId: "tab",
		lastBeat: now - 10_000,
		visible: true,
		visibleSince: now - 60_000,
		autoReloadedAt: null,
	};
	const visible = { visibilityState: "visible", canNavigate: true };
	assert.equal(verdict(watch, visible, now, false), "reload");
	assert.equal(verdict(watch, null, now, false), "gone");
	assert.equal(verdict({ ...watch, lastBeat: now - 9_999 }, visible, now, false), "wait");
	// Hidden now, or at its last heartbeat: timers are throttled there, so silence says nothing.
	assert.equal(verdict(watch, { ...visible, visibilityState: "hidden" }, now, false), "hidden");
	assert.equal(verdict({ ...watch, visible: false }, visible, now, false), "hidden");
	// Shown again only now: its silence counts from then.
	assert.equal(verdict({ ...watch, lastBeat: now - 60_000, visibleSince: now - 5_000 }, visible, now, false), "wait");
	assert.equal(verdict({ ...watch, tabId: null }, visible, now, false), "no-tab");
	// Reloaded already in this failed start, by the worker's state or the page's marker, however long ago.
	assert.equal(verdict(watch, visible, now, true), "already-reloaded");
	assert.equal(verdict({ ...watch, autoReloadedAt: now - 3_600_000 }, visible, now, false), "already-reloaded");
	assert.equal(verdict(watch, { ...visible, canNavigate: false }, now, false), "unsupported");
});

test("a visible tab whose heartbeats stop is reloaded once, reported, and told so on its next load", async () => {
	const worker = loadWorker();
	worker.tabs.set("client-1", { url: "https://mail.example.com/inbox", visibilityState: "visible" });
	await worker.beatFor("client-1", 3_000, BEAT);
	// The main thread froze: nothing more arrives. Not yet after 9 seconds.
	await worker.advance(9_000);
	assert.deepEqual(worker.navigations, []);
	await worker.advance(2_500);
	assert.deepEqual(worker.navigations, [{ id: "client-1", url: "https://mail.example.com/inbox" }]);
	assert.equal(worker.reports.length, 1);
	assert.equal(worker.reports[0].url, "/api/boot-report");
	assert.equal(worker.reports[0].credentials, "same-origin");
	assert.deepEqual(worker.reports[0].body, {
		event: "auto_reloaded_after_freeze",
		page: "/inbox",
		phase: "loader-mounted",
		step: "mailbox-shell",
		build: "2026.11.01.3 (abc1234)",
		afterMs: 950,
		visibleMs: 900,
	});
	// Every heartbeat kept the worker alive past the check that follows it.
	assert.ok(worker.held.length > 0);
	// The reloaded load (a new client id, the same tab id) hears it once, and then carries the marker.
	worker.tabs.set("client-2", { url: "https://mail.example.com/inbox", visibilityState: "visible" });
	worker.post("client-2", { type: "kite:boot-beat", ...BEAT });
	await worker.advance(0);
	assert.equal(worker.received.length, 1);
	assert.equal(worker.received[0].clientId, "client-2");
	assert.equal(worker.received[0].message.type, "kite:auto-reloaded");
	worker.post("client-2", { type: "kite:boot-beat", ...BEAT, autoReloadedAt: worker.received[0].message.at });
	await worker.advance(0);
	assert.equal(worker.received.length, 1);
	worker.post("client-2", { type: "kite:boot-done", tabId: "tab-1" });
	await worker.advance(15_000);
	assert.equal(worker.navigations.length, 1);
});

test("one reload per failed start: a start that freezes again is only reported until one goes through", async () => {
	const worker = loadWorker();
	worker.tabs.set("client-1", { url: "https://mail.example.com/inbox", visibilityState: "visible" });
	await worker.beatFor("client-1", 2_000, BEAT);
	await worker.advance(12_000);
	assert.equal(worker.navigations.length, 1);
	// A long finite block: the reloaded load comes up minutes later and freezes again.
	await worker.advance(300_000);
	worker.tabs.set("client-2", { url: "https://mail.example.com/inbox", visibilityState: "visible" });
	await worker.beatFor("client-2", 2_000, BEAT);
	await worker.advance(30_000);
	assert.equal(worker.navigations.length, 1);
	assert.deepEqual(
		worker.reports.map((report) => report.body.event),
		["auto_reloaded_after_freeze", "freeze_not_reloaded"],
	);
	// A start that goes through arms the tab again.
	worker.tabs.set("client-3", { url: "https://mail.example.com/inbox", visibilityState: "visible" });
	await worker.beatFor("client-3", 1_000, BEAT);
	worker.post("client-3", { type: "kite:boot-done", tabId: "tab-1" });
	await worker.advance(1_000);
	worker.tabs.set("client-4", { url: "https://mail.example.com/inbox", visibilityState: "visible" });
	await worker.beatFor("client-4", 2_000, BEAT);
	await worker.advance(12_000);
	assert.equal(worker.navigations.length, 2);
	// Leaving (the page's own watchdog took over) does not arm it.
	worker.tabs.set("client-5", { url: "https://mail.example.com/inbox", visibilityState: "visible" });
	await worker.beatFor("client-5", 1_000, BEAT);
	worker.post("client-5", { type: "kite:boot-leaving", tabId: "tab-1" });
	worker.tabs.set("client-6", { url: "https://mail.example.com/inbox", visibilityState: "visible" });
	await worker.beatFor("client-6", 2_000, BEAT);
	await worker.advance(12_000);
	assert.equal(worker.navigations.length, 2);
});

test("a worker the browser stopped and started again still knows the tab was reloaded", async () => {
	const cacheStore = new Map();
	const first = loadWorker({ cacheStore });
	first.tabs.set("client-1", { url: "https://mail.example.com/inbox", visibilityState: "visible" });
	await first.beatFor("client-1", 2_000, BEAT);
	await first.advance(12_000);
	assert.equal(first.navigations.length, 1);
	assert.equal(cacheStore.size, 1);
	// A new run of the worker: empty memory, the same Cache Storage; the page lost its marker too.
	const second = loadWorker({ cacheStore });
	second.tabs.set("client-2", { url: "https://mail.example.com/inbox", visibilityState: "visible" });
	await second.beatFor("client-2", 2_000, BEAT);
	await second.advance(15_000);
	assert.deepEqual(second.navigations, []);
	assert.deepEqual(
		second.reports.map((report) => report.body.event),
		["freeze_not_reloaded"],
	);
	// It still tells the reloaded load, and arms the tab again once a start went through.
	assert.equal(second.received[0].message.type, "kite:auto-reloaded");
	second.post("client-2", { type: "kite:boot-done", tabId: "tab-1" });
	await second.advance(0);
	const third = loadWorker({ cacheStore });
	third.tabs.set("client-3", { url: "https://mail.example.com/inbox", visibilityState: "visible" });
	await third.beatFor("client-3", 2_000, BEAT);
	await third.advance(12_000);
	assert.equal(third.navigations.length, 1);
	// The page's own marker stops a worker that has no Cache Storage at all.
	const bare = loadWorker();
	bare.sandbox.caches = undefined;
	bare.tabs.set("client-4", { url: "https://mail.example.com/inbox", visibilityState: "visible" });
	await bare.beatFor("client-4", 2_000, { ...BEAT, autoReloadedAt: bare.clock.now - 3_600_000 });
	await bare.advance(15_000);
	assert.deepEqual(bare.navigations, []);
});

test("a heartbeat that arrives while the browser looks the tab up wins over the silence before it", async () => {
	const worker = loadWorker({ lookupDelayMs: 1_500 });
	worker.tabs.set("client-1", { url: "https://mail.example.com/inbox", visibilityState: "visible" });
	await worker.beatFor("client-1", 2_000, BEAT);
	// Silent long enough that the next check looks the tab up; it beats again during that lookup.
	await worker.advance(10_200);
	worker.post("client-1", { type: "kite:boot-beat", ...BEAT });
	await worker.advance(1_500);
	assert.deepEqual(worker.navigations, []);
	assert.deepEqual(worker.reports, []);
	// It then really stops: the next silence of ten seconds reloads.
	await worker.advance(14_000);
	assert.equal(worker.navigations.length, 1);
});

test("after the computer slept, a tab's silence starts over instead of counting the sleep", async () => {
	const worker = loadWorker();
	worker.tabs.set("client-1", { url: "https://mail.example.com/inbox", visibilityState: "visible" });
	await worker.beatFor("client-1", 2_000, BEAT);
	worker.suspend(600_000);
	// Awake again: the page needs a moment before its first heartbeat; no reload meanwhile.
	await worker.advance(3_000);
	worker.post("client-1", { type: "kite:boot-beat", ...BEAT });
	await worker.advance(8_000);
	assert.deepEqual(worker.navigations, []);
	// A page that stays silent after waking is still reloaded, ten seconds after the wake-up.
	const silent = loadWorker();
	silent.tabs.set("client-1", { url: "https://mail.example.com/inbox", visibilityState: "visible" });
	await silent.beatFor("client-1", 2_000, BEAT);
	silent.suspend(600_000);
	await silent.advance(9_000);
	assert.deepEqual(silent.navigations, []);
	await silent.advance(3_000);
	assert.equal(silent.navigations.length, 1);
});

test("a hidden tab, a finished start, a page leaving and a tab without an id are never reloaded", async () => {
	const cases = {
		"hidden by the browser": async (worker) => {
			worker.tabs.get("client-1").visibilityState = "hidden";
			await worker.beatFor("client-1", 2_000, BEAT);
		},
		"hidden at its last heartbeat": async (worker) => {
			await worker.beatFor("client-1", 2_000, { ...BEAT, visible: false });
		},
		"startup finished": async (worker) => {
			await worker.beatFor("client-1", 2_000, BEAT);
			worker.post("client-1", { type: "kite:boot-done", tabId: "tab-1" });
		},
		"leaving by itself": async (worker) => {
			await worker.beatFor("client-1", 2_000, BEAT);
			worker.post("client-1", { type: "kite:boot-leaving", tabId: "tab-1" });
		},
		closed: async (worker) => {
			await worker.beatFor("client-1", 2_000, BEAT);
			worker.tabs.delete("client-1");
		},
		"no tab id": async (worker) => {
			await worker.beatFor("client-1", 2_000, { ...BEAT, tabId: null });
		},
	};
	for (const [label, run] of Object.entries(cases)) {
		const worker = loadWorker();
		worker.tabs.set("client-1", { url: "https://mail.example.com/inbox", visibilityState: "visible" });
		await run(worker);
		await worker.advance(30_000);
		assert.deepEqual(worker.navigations, [], label);
		const expected = label === "no tab id" ? ["freeze_not_reloaded"] : [];
		assert.deepEqual(
			worker.reports.map((report) => report.body.event),
			expected,
			label,
		);
	}
});

test("a tab shown again after it froze while hidden counts its silence from when it was shown", async () => {
	const worker = loadWorker();
	worker.tabs.set("client-1", { url: "https://mail.example.com/inbox", visibilityState: "visible" });
	await worker.beatFor("client-1", 2_000, BEAT);
	worker.tabs.get("client-1").visibilityState = "hidden";
	await worker.advance(20_000);
	worker.tabs.get("client-1").visibilityState = "visible";
	await worker.advance(8_000);
	assert.deepEqual(worker.navigations, []);
	await worker.advance(4_000);
	assert.equal(worker.navigations.length, 1);
});

test("without WindowClient.navigate the freeze is reported and nothing else happens", async () => {
	const worker = loadWorker({ navigate: false });
	worker.tabs.set("client-1", { url: "https://mail.example.com/inbox", visibilityState: "visible" });
	await worker.beatFor("client-1", 2_000, BEAT);
	await worker.advance(15_000);
	assert.deepEqual(
		worker.reports.map((report) => report.body.event),
		["freeze_not_reloaded"],
	);
});

test("messages that are not the watchdog's are ignored", async () => {
	const worker = loadWorker();
	worker.tabs.set("client-1", { url: "https://mail.example.com/inbox", visibilityState: "visible" });
	worker.post("client-1", null);
	worker.post("client-1", { type: "kite:copy-code", code: "123456" });
	worker.post("client-1", "kite:boot-beat");
	await worker.advance(30_000);
	assert.deepEqual(worker.navigations, []);
	assert.deepEqual(worker.held, []);
});
