import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-asset-recovery-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/components/asset-recovery-utils.ts")],
	outfile: join(bundleDirectory, "recovery.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	absWorkingDir: root,
	logLevel: "silent",
});
const { STALE_ASSETS_EVENT, assetRecoveryScript, markAppReady, markLoaderMounted, takeStaleAssetsSignal } =
	await import(pathToFileURL(join(bundleDirectory, "recovery.mjs")).href);
const ASSET_RELOAD_STORAGE_KEY = "kite:asset-reload";
const ASSET_RECOVERY_READY_FLAG = "__kiteAppReady";
const STALE_ASSETS_PENDING_FLAG = "__kiteStaleAssets";
const ASSET_RELOAD_WINDOW_MS = 120_000;
const LOADER_MOUNTED_FLAG = "__kiteLoaderMounted";
const BOOT_FAILURE_ID = "kite-boot-failure";
const ORIGIN = "https://mail.example.com";

class FakeElement {}
class HTMLScriptElement extends FakeElement {
	constructor(src) {
		super();
		this.src = src;
	}
}
class HTMLLinkElement extends FakeElement {
	constructor(rel, href) {
		super();
		this.rel = rel;
		this.href = href;
	}
}

/**
 * A minimal DOM: AuthGuard's server-rendered startup screen (`screen` is its role: "status" while the server's
 * screen is up, "" once React hid it, null for a page without one) and a body that records what the script adds.
 */
function fakeDocument({ screen = "status", declared = [], readyState = "complete", withBody = true } = {}) {
	const byId = new Map();
	const container = () => ({
		children: [],
		append(...elements) {
			for (const element of elements) {
				this.children.push(element);
				if (element.id) byId.set(element.id, element);
			}
		},
	});
	const body = withBody ? container() : null;
	const documentElement = container();
	const fake = {};
	const createElement = (tagName) => ({
		tagName,
		id: "",
		style: {},
		attributes: {},
		listeners: {},
		children: [],
		textContent: "",
		setAttribute(name, value) {
			this.attributes[name] = value;
		},
		getAttribute(name) {
			return this.attributes[name] ?? null;
		},
		hasAttribute(name) {
			return name in this.attributes;
		},
		// The startup screen's own way out (the slow-start recovery or a failure), when the test puts one in it.
		querySelector() {
			return this.wayOut ?? null;
		},
		addEventListener(type, listener) {
			this.listeners[type] = listener;
		},
		append(...children) {
			this.children.push(...children);
		},
		focus() {
			fake.activeElement = this;
		},
		remove() {
			for (const parent of [body, documentElement]) {
				if (parent) parent.children = parent.children.filter((child) => child !== this);
			}
			byId.delete(this.id);
		},
	});
	const overlay = screen === null ? null : createElement("div");
	if (overlay && screen) overlay.setAttribute("role", screen);
	return Object.assign(fake, {
		overlay,
		body,
		documentElement,
		activeElement: null,
		createElement,
		getElementById: (id) => byId.get(id) ?? null,
		querySelector: (selector) => (selector === "[data-loading-overlay]" ? fake.overlay : null),
		// React replaces the startup screen's element (a remount), keeping its role and what it shows.
		remountOverlay() {
			const next = createElement("div");
			next.attributes = { ...fake.overlay.attributes };
			next.wayOut = fake.overlay.wayOut;
			fake.overlay = next;
		},
		querySelectorAll: () => declared,
		readyState,
		visibilityState: "visible",
	});
}

/**
 * A page with the script in its <head>. Timers wait until `runTimers()`; storage survives `reload()`, which is
 * only counted. `clock.now` moves time; `advance(ms)` moves it in watchdog ticks. `finishAsset()` reports a file
 * of ours that finished loading, as a PerformanceObserver resource entry; `parse()` is the parser adding nodes
 * while the document streams in (a MutationObserver record).
 */
function loadPage({
	storage = new Map(),
	clock = { now: 1_000_000 },
	online = true,
	ready = false,
	dev = false,
	screen = "status",
	declared = [],
	readyState = "complete",
	withBody = true,
	flags = {},
} = {}) {
	const listeners = new Map();
	const timers = [];
	const intervals = new Map();
	let nextInterval = 1;
	let observer = null;
	let parser = null;
	const document = fakeDocument({ screen, declared, readyState, withBody });
	const page = { reloads: 0, waits: [], dispatched: [], errors: [], storage, clock, document };
	const sandbox = {
		location: { href: `${ORIGIN}/inbox`, origin: ORIGIN, reload: () => (page.reloads += 1) },
		navigator: { onLine: online },
		sessionStorage: {
			getItem: (key) => (storage.has(key) ? storage.get(key) : null),
			setItem: (key, value) => storage.set(key, String(value)),
			removeItem: (key) => storage.delete(key),
		},
		console: { error: (message) => page.errors.push(message) },
		Date: { now: () => clock.now },
		URL,
		Event: class {
			constructor(type) {
				this.type = type;
			}
		},
		HTMLScriptElement,
		HTMLLinkElement,
		document,
		PerformanceObserver: class {
			constructor(callback) {
				observer = callback;
			}
			observe() {}
		},
		MutationObserver: class {
			constructor(callback) {
				parser = callback;
			}
			observe() {}
			disconnect() {
				parser = null;
			}
		},
		setTimeout: (callback, ms) => {
			page.waits.push(ms);
			timers.push(callback);
		},
		setInterval: (callback) => {
			intervals.set(nextInterval, callback);
			return nextInterval++;
		},
		clearInterval: (id) => intervals.delete(id),
		addEventListener: (type, listener) => listeners.set(type, [...(listeners.get(type) ?? []), listener]),
		dispatchEvent: (event) => page.dispatched.push(event.type),
		...flags,
	};
	sandbox.window = sandbox;
	if (ready) sandbox[ASSET_RECOVERY_READY_FLAG] = true;
	vm.runInNewContext(assetRecoveryScript({ dev }), sandbox);
	page.window = sandbox;
	page.fire = (type, event = { type }) => {
		for (const listener of listeners.get(type) ?? []) listener(event);
	};
	page.runTimers = () => {
		for (const callback of timers.splice(0)) callback();
	};
	page.watching = () => intervals.size > 0;
	page.advance = (ms) => {
		for (let elapsed = 0; elapsed < ms; elapsed += 500) {
			clock.now += 500;
			for (const callback of [...intervals.values()]) callback();
		}
	};
	page.finishAsset = (name = `${ORIGIN}/_next/static/chunks/a.js`) => observer?.({ getEntries: () => [{ name }] });
	page.parse = () => parser?.([]);
	page.failure = () => document.getElementById(BOOT_FAILURE_ID);
	page.state = () => JSON.parse(storage.get(ASSET_RELOAD_STORAGE_KEY) ?? "null");
	return page;
}

const missingEntry = { target: new HTMLScriptElement(`${ORIGIN}/_next/static/chunks/index-new.js`) };

test("a missing chunk before the app renders reloads after a growing wait, four times at most", () => {
	const storage = new Map();
	const clock = { now: 1_000_000 };
	const waits = [];
	let reloads = 0;
	for (let attempt = 0; attempt < 6; attempt += 1) {
		const page = loadPage({ storage, clock });
		page.fire("error", missingEntry);
		// A second failure on the same page schedules nothing more.
		page.fire("error", missingEntry);
		// Nothing is counted until the timer fires.
		assert.equal(page.state()?.count ?? 0, Math.min(attempt, 4));
		page.runTimers();
		waits.push(...page.waits);
		reloads += page.reloads;
		if (attempt >= 4) {
			assert.deepEqual(page.errors, ["[kite] The app's files could not be loaded after 4 reloads."]);
			// The startup screen is still the server's: a static message with a Reload button.
			assert.ok(page.failure());
		}
		clock.now += 1_000;
	}
	assert.deepEqual(waits, [1_000, 2_000, 4_000, 8_000]);
	assert.equal(reloads, 4);
});

test("a reload still waiting when the app renders is called off and becomes an update check", () => {
	const page = loadPage();
	page.fire("error", missingEntry);
	assert.deepEqual(page.waits, [1_000]);
	page.window[ASSET_RECOVERY_READY_FLAG] = true;
	page.runTimers();
	assert.equal(page.reloads, 0);
	assert.equal(page.state(), null);
	assert.deepEqual(page.dispatched, [STALE_ASSETS_EVENT]);
});

test("the count starts over after its window and once the app has rendered", () => {
	const storage = new Map([[ASSET_RELOAD_STORAGE_KEY, JSON.stringify({ count: 4, since: 1_000_000 })]]);
	const stale = loadPage({ storage, clock: { now: 1_000_000 + ASSET_RELOAD_WINDOW_MS + 1 } });
	stale.fire("error", missingEntry);
	stale.runTimers();
	assert.deepEqual(stale.waits, [1_000]);
	assert.equal(stale.reloads, 1);
	assert.equal(stale.state().count, 1);

	globalThis.window = {};
	globalThis.sessionStorage = { removeItem: (key) => storage.delete(key) };
	try {
		markAppReady();
		assert.equal(globalThis.window[ASSET_RECOVERY_READY_FLAG], true);
		assert.equal(storage.has(ASSET_RELOAD_STORAGE_KEY), false);
	} finally {
		delete globalThis.window;
		delete globalThis.sessionStorage;
	}
});

test("only Kite's own hashed files count: module preloads, stylesheets, preload errors and import failures", () => {
	const counted = [
		["error", { target: new HTMLLinkElement("modulepreload", "/_next/static/chunks/providers-new.js") }],
		["error", { target: new HTMLLinkElement("stylesheet", "/_next/static/css/app-new.css") }],
		["vite:preloadError", { payload: new Error("Unable to preload CSS for /_next/static/css/app-new.css") }],
		[
			"unhandledrejection",
			{
				reason: new TypeError(`Failed to fetch dynamically imported module: ${ORIGIN}/_next/static/chunks/a.js`),
			},
		],
		// Safari names no file.
		["unhandledrejection", { reason: new TypeError("Importing a module script failed.") }],
	];
	for (const [type, event] of counted) {
		const page = loadPage();
		page.fire(type, event);
		page.runTimers();
		assert.equal(page.reloads, 1, `${type} ${event.target?.href ?? event.reason?.message ?? event.payload?.message}`);
	}
});

test("blocked scripts outside the asset path, other origins, fonts, offline and unrelated errors never reload", () => {
	const ignored = [
		// A same-origin script a CSP or an ad blocker refused, outside the hashed asset path.
		["error", { target: new HTMLScriptElement(`${ORIGIN}/api/branding/analytics.js`) }],
		["error", { target: new HTMLScriptElement("https://challenges.cloudflare.com/turnstile/v0/api.js") }],
		["error", { target: new HTMLLinkElement("preload", `${ORIGIN}/_next/static/_vinext_fonts/a.woff2`) }],
		["error", { target: new HTMLScriptElement("") }],
		["error", { target: {} }],
		// A dynamic import of a third-party module (an extension, a widget) that failed.
		[
			"unhandledrejection",
			{ reason: new TypeError("Failed to fetch dynamically imported module: https://cdn.example.net/widget.js") },
		],
		["vite:preloadError", { payload: new Error("Unable to preload CSS for https://cdn.example.net/x.css") }],
		["unhandledrejection", { reason: new Error("Network request failed") }],
		// Vite's own paths only count in development.
		["error", { target: new HTMLScriptElement(`${ORIGIN}/@id/__x00__virtual:vite-rsc/entry-browser`) }],
	];
	for (const [type, event] of ignored) {
		const page = loadPage();
		page.fire(type, event);
		page.runTimers();
		assert.deepEqual([page.waits, page.reloads], [[], 0], `${type} ${event.target?.src ?? event.reason?.message}`);
	}
	const offline = loadPage({ online: false });
	offline.fire("error", missingEntry);
	offline.runTimers();
	assert.equal(offline.reloads, 0);

	const dev = loadPage({ dev: true });
	dev.fire("error", { target: new HTMLScriptElement(`${ORIGIN}/@id/__x00__virtual:vite-rsc/entry-browser`) });
	dev.runTimers();
	assert.equal(dev.reloads, 1);
});

test("after the app has rendered a missing chunk asks for an update check, at most once per 30 seconds", () => {
	const clock = { now: 1_000_000 };
	const page = loadPage({ ready: true, clock });
	page.fire("vite:preloadError", {});
	page.fire("error", missingEntry);
	assert.deepEqual(page.waits, []);
	assert.deepEqual(page.dispatched, [STALE_ASSETS_EVENT]);
	assert.equal(page.state(), null);
	assert.equal(page.window[STALE_ASSETS_PENDING_FLAG], true);

	clock.now += 29_999;
	page.fire("error", missingEntry);
	assert.equal(page.dispatched.length, 1);
	// A later failure is not dropped.
	clock.now += 1;
	page.fire("error", missingEntry);
	assert.deepEqual(page.dispatched, [STALE_ASSETS_EVENT, STALE_ASSETS_EVENT]);
});

test("a signal sent before anyone listened is handed to the first listener once", () => {
	globalThis.window = { [STALE_ASSETS_PENDING_FLAG]: true };
	try {
		assert.equal(takeStaleAssetsSignal(), true);
		assert.equal(takeStaleAssetsSignal(), false);
	} finally {
		delete globalThis.window;
	}
});

test("without working storage nothing could stop a loop, so it never reloads", () => {
	const page = loadPage({ storage: { has: () => false, get: () => null, set: () => {}, delete: () => {} } });
	page.fire("error", missingEntry);
	page.runTimers();
	assert.equal(page.reloads, 0);
});

test("a startup screen React never took over reloads after 8 visible seconds, twice, then shows Kite couldn't load", () => {
	const storage = new Map();
	const clock = { now: 1_000_000 };
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const page = loadPage({ storage, clock });
		page.advance(7_500);
		assert.equal(page.reloads, 0);
		page.advance(500);
		assert.equal(page.reloads, 1, `attempt ${attempt}`);
		assert.deepEqual([page.state().count, page.state().stalls], [attempt + 1, attempt + 1]);
		clock.now += 1_000;
	}
	// The third stall within the window: a static message with a Reload button, which gets the focus.
	const last = loadPage({ storage, clock });
	last.advance(8_000);
	assert.equal(last.reloads, 0);
	assert.equal(last.watching(), false);
	assert.deepEqual(last.errors, ["[kite] The app did not start after 2 automatic reloads."]);
	const failure = last.failure();
	assert.equal(failure.getAttribute("role"), "alert");
	const [text, button] = failure.children;
	assert.equal(text.textContent, "Kite couldn't load.");
	assert.equal(button.textContent, "Reload");
	assert.equal(last.document.activeElement, button);
	last.fire("click", { target: { closest: () => null } });
	assert.equal(last.reloads, 0);
	// The click is handled on window, before React's listener on document could stop it.
	assert.equal(button.listeners.click, undefined);
	last.fire("click", {
		target: { closest: (selector) => (selector === `#${BOOT_FAILURE_ID} [data-boot-reload]` ? button : null) },
	});
	// Reload starts over with a fresh budget.
	assert.equal(last.reloads, 1);
	assert.equal(last.state(), null);
});

test("watchdog reloads share the budget with failed chunks, which keep their own four", () => {
	const clock = { now: 1_000_000 };
	// Two chunk reloads already happened: the watchdog still gets its two, then the budget of four is spent.
	const storage = new Map([[ASSET_RELOAD_STORAGE_KEY, JSON.stringify({ count: 2, since: clock.now })]]);
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const page = loadPage({ storage, clock });
		page.advance(8_000);
		assert.equal(page.reloads, 1);
	}
	const { count, stalls } = JSON.parse(storage.get(ASSET_RELOAD_STORAGE_KEY));
	assert.deepEqual([count, stalls], [4, 2]);
	const spent = loadPage({ storage, clock });
	spent.fire("error", missingEntry);
	assert.ok(spent.failure());
	assert.equal(spent.reloads, 0);
	// A stall reload leaves a failed chunk its reloads.
	const stalled = new Map([[ASSET_RELOAD_STORAGE_KEY, JSON.stringify({ count: 2, since: clock.now, stalls: 2 })]]);
	const chunk = loadPage({ storage: stalled, clock });
	chunk.fire("error", missingEntry);
	chunk.runTimers();
	assert.equal(chunk.reloads, 1);
});

test("a load that keeps moving is never cut short; a hung one is acted on after 20 quiet seconds", () => {
	// Files keep arriving: only the 60-second ceiling stops it.
	const moving = loadPage();
	for (let elapsed = 0; elapsed < 59_000; elapsed += 1_000) {
		moving.finishAsset();
		moving.advance(1_000);
	}
	assert.equal(moving.reloads, 0);
	moving.finishAsset();
	moving.advance(1_000);
	assert.equal(moving.reloads, 1);

	// A file the document names has not finished: waits until nothing progressed for 20 seconds.
	const chunk = `${ORIGIN}/_next/static/chunks/auth-guard.js`;
	const named = [
		Object.assign(new HTMLScriptElement(chunk), { tagName: "SCRIPT" }),
		Object.assign(new HTMLLinkElement("preload", `${ORIGIN}/_next/static/fonts/a.woff2`), { tagName: "LINK" }),
	];
	const hung = loadPage({ declared: named });
	hung.advance(5_000);
	hung.finishAsset();
	hung.advance(19_500);
	assert.equal(hung.reloads, 0);
	hung.advance(500);
	assert.equal(hung.reloads, 1);
	// After a watchdog reload in this window, 10 quiet seconds are enough.
	const repeat = loadPage({
		declared: named,
		storage: new Map([[ASSET_RELOAD_STORAGE_KEY, JSON.stringify({ count: 1, since: 1_000_000, stalls: 1 })]]),
	});
	repeat.advance(9_500);
	assert.equal(repeat.reloads, 0);
	repeat.advance(500);
	assert.equal(repeat.reloads, 1);
	// It arrives within the quiet time: nothing to do once React takes over.
	const late = loadPage({ declared: named });
	late.advance(15_000);
	late.finishAsset(chunk);
	late.window[LOADER_MOUNTED_FLAG] = true;
	late.advance(30_000);
	assert.equal(late.reloads, 0);
	// Once it has finished, the font preload does not count, and 3 quiet seconds are enough.
	const done = loadPage({ declared: named });
	done.finishAsset(chunk);
	done.advance(7_500);
	assert.equal(done.reloads, 0);
	done.advance(500);
	assert.equal(done.reloads, 1);

	// Only our own files count as progress.
	const other = loadPage();
	other.finishAsset(`${ORIGIN}/api/auth/me`);
	other.advance(8_000);
	assert.equal(other.reloads, 1);

	// A load that went quiet with nothing left is acted on 3 seconds after its last file.
	const quiet = loadPage();
	quiet.advance(7_000);
	quiet.finishAsset();
	quiet.advance(2_500);
	assert.equal(quiet.reloads, 0);
	quiet.advance(500);
	assert.equal(quiet.reloads, 1);
});

test("a document still streaming in is progress while the parser adds nodes, and a stalled stream goes quiet", () => {
	const page = loadPage({ readyState: "loading" });
	for (let elapsed = 0; elapsed < 30_000; elapsed += 2_000) {
		page.advance(2_000);
		page.parse();
	}
	assert.equal(page.reloads, 0);
	page.advance(19_500);
	assert.equal(page.reloads, 0);
	page.advance(500);
	assert.equal(page.reloads, 1);
	// Parsing done: the observer is gone.
	const parsed = loadPage({ readyState: "loading" });
	parsed.fire("DOMContentLoaded");
	assert.equal(parsed.parse(), undefined);
});

test("a background tab does not count, and without a body the message goes on the root element", () => {
	const hidden = loadPage();
	hidden.document.visibilityState = "hidden";
	hidden.advance(60_000);
	assert.equal(hidden.reloads, 0);
	hidden.document.visibilityState = "visible";
	hidden.advance(8_000);
	assert.equal(hidden.reloads, 1);

	const noBody = loadPage({ withBody: false, online: false });
	noBody.advance(8_000);
	assert.equal(noBody.document.documentElement.children[0], noBody.failure());
});

test("a page React runs, or one that is done loading, is left alone", () => {
	const cases = [
		// The startup screen is hidden: React rendered it away.
		{ screen: "" },
		// No startup screen (sign-in) and the app has rendered.
		{ screen: null, ready: true },
	];
	for (const options of cases) {
		const page = loadPage(options);
		page.advance(30_000);
		assert.deepEqual([page.reloads, page.failure(), page.watching()], [0, null, false], JSON.stringify(options));
	}
	// A screen React runs is never reloaded; only its outer bound is kept (below).
	const running = loadPage({ flags: { [LOADER_MOUNTED_FLAG]: true } });
	running.advance(29_500);
	assert.deepEqual([running.reloads, running.failure(), running.watching()], [0, null, true]);
	running.document.overlay.setAttribute("role", "");
	// It stops once the screen has stayed down for two seconds, not at the first tick.
	running.advance(1_500);
	assert.equal(running.watching(), true);
	running.advance(500);
	assert.deepEqual([running.reloads, running.failure(), running.watching()], [0, null, false]);
	// The root rendering is not enough while the part with the startup screen never did.
	const suspended = loadPage({ ready: true });
	suspended.advance(8_000);
	assert.equal(suspended.reloads, 1);
	// Without a startup screen, an app that never rendered counts as stalled.
	const blank = loadPage({ screen: null });
	blank.advance(8_000);
	assert.equal(blank.reloads, 1);
});

test("offline or without storage the watchdog shows the message, and coming back online reloads", () => {
	const offline = loadPage({ online: false });
	offline.advance(8_000);
	assert.equal(offline.reloads, 0);
	assert.ok(offline.failure());
	offline.fire("online");
	assert.equal(offline.reloads, 1);

	// Once React runs the page, coming online does nothing.
	const live = loadPage({ online: false });
	live.advance(8_000);
	live.window[LOADER_MOUNTED_FLAG] = true;
	live.fire("online");
	assert.equal(live.reloads, 0);

	const noStorage = loadPage({ storage: { has: () => false, get: () => null, set: () => {}, delete: () => {} } });
	noStorage.advance(8_000);
	assert.equal(noStorage.reloads, 0);
	assert.ok(noStorage.failure());
});

test("a failed chunk's pending reload is left to run, and giving up on chunks shows the message at once", () => {
	const page = loadPage();
	page.fire("error", missingEntry);
	page.advance(8_000);
	assert.equal(page.reloads, 0);
	page.runTimers();
	assert.equal(page.reloads, 1);

	const storage = new Map([[ASSET_RELOAD_STORAGE_KEY, JSON.stringify({ count: 4, since: 1_000_000 })]]);
	const spent = loadPage({ storage });
	spent.fire("error", missingEntry);
	assert.ok(spent.failure());
	assert.equal(spent.reloads, 0);
});

test("the message and the count go when React takes over the startup screen, not merely when the root renders", () => {
	const storage = new Map([[ASSET_RELOAD_STORAGE_KEY, JSON.stringify({ count: 4, since: 1_000_000 })]]);
	const page = loadPage({ storage });
	page.advance(8_000);
	assert.ok(page.failure());
	globalThis.window = page.window;
	globalThis.document = page.document;
	globalThis.sessionStorage = page.window.sessionStorage;
	try {
		// The root rendered, but the startup screen is still the server's: keep the message and the budget.
		markAppReady();
		assert.ok(page.failure());
		assert.equal(page.state().count, 4);
		markLoaderMounted();
		assert.equal(page.window[LOADER_MOUNTED_FLAG], true);
		assert.equal(page.failure(), null);
		assert.equal(page.state(), null);
	} finally {
		delete globalThis.window;
		delete globalThis.document;
		delete globalThis.sessionStorage;
	}
});

test("a startup screen React runs but never ends gets Kite couldn't load after 30 visible seconds, never a reload", () => {
	const page = loadPage({ flags: { [LOADER_MOUNTED_FLAG]: true } });
	page.advance(29_500);
	assert.equal(page.failure(), null);
	page.advance(500);
	assert.ok(page.failure(), "the outer bound shows the message");
	assert.equal(page.failure().getAttribute("role"), "alert");
	assert.deepEqual(page.errors, ["[kite] The app did not finish starting."]);
	page.advance(10_000);
	assert.equal(page.reloads, 0);
	assert.equal(page.errors.length, 1);
	globalThis.window = page.window;
	globalThis.document = page.document;
	globalThis.sessionStorage = page.window.sessionStorage;
	try {
		// A screen that remounts (the cause it guards against) cannot take the message away.
		markLoaderMounted();
		markAppReady();
		assert.ok(page.failure());
	} finally {
		delete globalThis.window;
		delete globalThis.document;
		delete globalThis.sessionStorage;
	}
	// Reload starts over; and once the screen goes after all, so does the message.
	page.fire("click", {
		target: { closest: (selector) => (selector === "#kite-boot-failure [data-boot-reload]" ? {} : null) },
	});
	assert.equal(page.reloads, 1);
	page.document.overlay.setAttribute("role", "");
	page.advance(500);
	assert.equal(page.failure(), null);
	page.advance(1_500);
	assert.equal(page.watching(), false);
});

test("the outer bound leaves a screen alone while it shows its own way out, and counts only visible time", () => {
	const recovering = loadPage({ flags: { [LOADER_MOUNTED_FLAG]: true } });
	recovering.document.overlay.wayOut = { className: "loading-recovery" };
	recovering.advance(60_000);
	assert.equal(recovering.failure(), null);
	assert.equal(recovering.watching(), true);

	const hidden = loadPage({ flags: { [LOADER_MOUNTED_FLAG]: true } });
	hidden.document.visibilityState = "hidden";
	hidden.advance(60_000);
	assert.equal(hidden.failure(), null);
	hidden.document.visibilityState = "visible";
	hidden.advance(30_000);
	assert.ok(hidden.failure());
});

test("a frozen or hidden page does not wake up to a quiet period and reload at once", () => {
	const chunk = `${ORIGIN}/_next/static/chunks/auth-guard.js`;
	const named = [Object.assign(new HTMLScriptElement(chunk), { tagName: "SCRIPT" })];
	// A load still moving when the page is frozen (an app switch on iOS): no ticks run for a minute.
	const frozen = loadPage({ declared: named });
	frozen.advance(10_000);
	frozen.finishAsset();
	frozen.clock.now += 60_000;
	frozen.advance(500);
	assert.equal(frozen.reloads, 0);
	// Back on screen, it still waits 20 quiet seconds of its own.
	frozen.advance(18_500);
	assert.equal(frozen.reloads, 0);
	frozen.advance(1_000);
	assert.equal(frozen.reloads, 1);

	// Hidden ticks count neither as visible nor as quiet time.
	const hidden = loadPage({ declared: named });
	hidden.advance(10_000);
	hidden.finishAsset();
	hidden.document.visibilityState = "hidden";
	hidden.advance(120_000);
	hidden.document.visibilityState = "visible";
	hidden.advance(19_500);
	assert.equal(hidden.reloads, 0);
	hidden.advance(500);
	assert.equal(hidden.reloads, 1);

	// A clock that jumps back cannot add or remove time.
	const skewed = loadPage();
	skewed.clock.now -= 30_000;
	skewed.advance(7_500);
	assert.equal(skewed.reloads, 0);
});

test("a startup screen that keeps being mounted again is stuck even while it shows Reload Kite", () => {
	const page = loadPage({ flags: { [LOADER_MOUNTED_FLAG]: true } });
	page.document.overlay.wayOut = { className: "loading-recovery" };
	page.advance(500);
	// Two remounts: still its own way out.
	for (let remount = 0; remount < 2; remount += 1) {
		page.document.remountOverlay();
		page.advance(500);
	}
	page.advance(40_000);
	assert.equal(page.failure(), null);
	// A third: a remount loop, which keeps taking React's "Reload Kite" away again.
	page.document.remountOverlay();
	page.advance(500);
	assert.ok(page.failure());
	assert.equal(page.failure().getAttribute("data-loader-stuck"), "");
	assert.deepEqual(page.errors, [
		"[kite] The app did not finish starting: its startup screen was mounted again 3 times.",
	]);
	assert.equal(page.reloads, 0);
	// Before the outer bound a remount loop waits like any other stuck screen.
	const early = loadPage({ flags: { [LOADER_MOUNTED_FLAG]: true } });
	early.document.overlay.wayOut = { className: "loading-recovery" };
	early.advance(500);
	for (let remount = 0; remount < 5; remount += 1) {
		early.document.remountOverlay();
		early.advance(500);
	}
	assert.equal(early.failure(), null);
	early.advance(26_500);
	assert.equal(early.failure(), null);
	early.advance(500);
	assert.ok(early.failure());
});

test("a failure in the screen keeps the watchdog going, and Retry back to the loading screen gets a new bound", () => {
	const page = loadPage({ flags: { [LOADER_MOUNTED_FLAG]: true } });
	page.advance(20_000);
	// React shows "Kite couldn't check your sign-in" in the screen: no longer a status, a way out of its own.
	page.document.overlay.setAttribute("role", "");
	page.document.overlay.wayOut = { role: "alert" };
	page.advance(60_000);
	assert.equal(page.watching(), true);
	assert.equal(page.failure(), null);
	// Retry: the loading screen is back, and it never finishes.
	page.document.overlay.setAttribute("role", "status");
	page.document.overlay.wayOut = undefined;
	page.advance(29_500);
	assert.equal(page.failure(), null);
	page.advance(500);
	assert.ok(page.failure());
	// A screen that briefly leaves and comes back without a failure keeps its count.
	const brief = loadPage({ flags: { [LOADER_MOUNTED_FLAG]: true } });
	brief.advance(20_000);
	brief.document.overlay.setAttribute("role", "");
	brief.advance(1_000);
	brief.document.overlay.setAttribute("role", "status");
	brief.advance(9_000);
	assert.ok(brief.failure());
});

/** A boot trace (boot-trace-utils.ts) on the page's window that records what the watchdog tells it. */
function fakeTrace() {
	const trace = {
		beats: [],
		remounts: [],
		ended: 0,
		beat: (visibleMs) => trace.beats.push(visibleMs),
		remount: (count) => trace.remounts.push(count),
		end: () => (trace.ended += 1),
		text: () => "Phase: loader-mounted",
		details: () => ({ phase: "loader-mounted" }),
	};
	return trace;
}

test("every tick is a heartbeat for the boot trace, which ends when the watchdog stops", () => {
	const trace = fakeTrace();
	const page = loadPage({ flags: { [LOADER_MOUNTED_FLAG]: true, __kiteBoot: trace } });
	page.advance(1_500);
	assert.deepEqual(trace.beats, [500, 1_000, 1_500]);
	page.document.remountOverlay();
	page.advance(500);
	page.document.remountOverlay();
	page.advance(500);
	assert.deepEqual(trace.remounts, [1, 2]);
	page.document.overlay.setAttribute("role", "");
	page.advance(2_000);
	assert.equal(page.watching(), false);
	assert.equal(trace.ended, 1);
	// Hidden time is no visible time, but the heartbeat goes on.
	const hidden = fakeTrace();
	const background = loadPage({ flags: { __kiteBoot: hidden } });
	background.document.visibilityState = "hidden";
	background.advance(1_000);
	assert.deepEqual(hidden.beats, [0, 0]);
	// Without a trace (it failed to start) the watchdog works as before.
	const plain = loadPage();
	plain.advance(8_000);
	assert.equal(plain.reloads, 1);
});

test("Kite couldn't load carries the trace's Details, and Copy details copies them as JSON", async () => {
	const trace = fakeTrace();
	const copied = [];
	const page = loadPage({ flags: { [LOADER_MOUNTED_FLAG]: true, __kiteBoot: trace } });
	page.window.navigator.clipboard = { writeText: async (text) => copied.push(text) };
	page.advance(30_000);
	const [, button, details] = page.failure().children;
	assert.equal(button.getAttribute("data-boot-reload"), "");
	assert.equal(details.tagName, "details");
	const [summary, lines, copy] = details.children;
	assert.equal(summary.textContent, "Details");
	assert.equal(lines.textContent, "Phase: loader-mounted");
	assert.equal(copy.textContent, "Copy details");
	page.fire("click", {
		target: { closest: (selector) => (selector === `#${BOOT_FAILURE_ID} [data-boot-copy]` ? copy : null) },
	});
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(
		copied.map((text) => JSON.parse(text)),
		[{ phase: "loader-mounted" }],
	);
	assert.equal(copy.textContent, "Copied");
	// Copying is no reload.
	assert.equal(page.reloads, 0);
	// Opened later, it shows the trace as it is then.
	trace.text = () => "Phase: auth-ready";
	details.open = true;
	details.listeners.toggle();
	assert.equal(lines.textContent, "Phase: auth-ready");
	// Without a trace the box has no Details.
	const plain = loadPage({ flags: { [LOADER_MOUNTED_FLAG]: true } });
	plain.advance(30_000);
	assert.equal(plain.failure().children.length, 2);
});
