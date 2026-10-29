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
function fakeDocument({ screen = "status", declared = [] } = {}) {
	const byId = new Map();
	const body = {
		children: [],
		append(...elements) {
			for (const element of elements) {
				this.children.push(element);
				if (element.id) byId.set(element.id, element);
			}
		},
	};
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
		addEventListener(type, listener) {
			this.listeners[type] = listener;
		},
		append(...children) {
			this.children.push(...children);
		},
		remove() {
			body.children = body.children.filter((child) => child !== this);
			byId.delete(this.id);
		},
	});
	const overlay = screen === null ? null : createElement("div");
	if (overlay && screen) overlay.setAttribute("role", screen);
	return {
		body,
		createElement,
		getElementById: (id) => byId.get(id) ?? null,
		querySelector: (selector) => (selector === "[data-loading-overlay]" ? overlay : null),
		querySelectorAll: () => declared,
		visibilityState: "visible",
	};
}

/**
 * A page with the script in its <head>. Timers wait until `runTimers()`; storage survives `reload()`, which is
 * only counted. `clock.now` moves time; `advance(ms)` moves it in watchdog ticks. `finishAsset()` reports a file
 * of ours that finished loading, as a PerformanceObserver resource entry.
 */
function loadPage({
	storage = new Map(),
	clock = { now: 1_000_000 },
	online = true,
	ready = false,
	dev = false,
	screen = "status",
	declared = [],
	flags = {},
} = {}) {
	const listeners = new Map();
	const timers = [];
	const intervals = new Map();
	let nextInterval = 1;
	let observer = null;
	const document = fakeDocument({ screen, declared });
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

test("a startup screen React never took over reloads after 8 visible seconds, then shows Kite couldn't load", () => {
	const storage = new Map();
	const clock = { now: 1_000_000 };
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const page = loadPage({ storage, clock });
		page.advance(7_500);
		assert.equal(page.reloads, 0);
		page.advance(500);
		assert.equal(page.reloads, 1, `attempt ${attempt}`);
		assert.equal(page.state().count, attempt + 1);
		clock.now += 1_000;
	}
	// The budget a failed chunk also uses is spent: a static message with a Reload button instead.
	const last = loadPage({ storage, clock });
	last.advance(8_000);
	assert.equal(last.reloads, 0);
	assert.equal(last.watching(), false);
	last.fire("click", { target: { closest: () => null } });
	assert.equal(last.reloads, 0);
	const failure = last.failure();
	assert.equal(failure.getAttribute("role"), "alert");
	const [text, button] = failure.children;
	assert.equal(text.textContent, "Kite couldn't load.");
	assert.equal(button.textContent, "Reload");
	// Reload starts over with a fresh budget.
	// The click is handled on window, before React's listener on document could stop it.
	assert.equal(button.listeners.click, undefined);
	last.fire("click", {
		target: { closest: (selector) => (selector === `#${BOOT_FAILURE_ID} button` ? button : null) },
	});
	assert.equal(last.reloads, 1);
	assert.equal(last.state(), null);
});

test("the watchdog waits while files keep arriving, up to 20 seconds, and counts only visible time", () => {
	const page = loadPage();
	for (let elapsed = 0; elapsed < 18_000; elapsed += 1_000) {
		page.finishAsset();
		page.advance(1_000);
	}
	assert.equal(page.reloads, 0);
	// Still arriving, but the cap is reached.
	page.finishAsset();
	page.advance(2_000);
	assert.equal(page.reloads, 1);

	// Only our own files count as progress.
	const other = loadPage();
	other.finishAsset(`${ORIGIN}/api/auth/me`);
	other.advance(8_000);
	assert.equal(other.reloads, 1);

	// A load that went quiet is acted on 3 seconds after its last file.
	const quiet = loadPage();
	quiet.advance(7_000);
	quiet.finishAsset();
	quiet.advance(2_500);
	assert.equal(quiet.reloads, 0);
	quiet.advance(500);
	assert.equal(quiet.reloads, 1);

	// A file the document names that has not finished holds it, up to the cap.
	const chunk = `${ORIGIN}/_next/static/chunks/auth-guard.js`;
	const named = [
		Object.assign(new HTMLScriptElement(chunk), { tagName: "SCRIPT" }),
		Object.assign(new HTMLLinkElement("preload", `${ORIGIN}/_next/static/fonts/a.woff2`), { tagName: "LINK" }),
	];
	const pending = loadPage({ declared: named });
	pending.advance(19_500);
	assert.equal(pending.reloads, 0);
	pending.advance(500);
	assert.equal(pending.reloads, 1);
	const done = loadPage({ declared: named });
	done.finishAsset(chunk);
	done.advance(7_500);
	assert.equal(done.reloads, 0);
	// The font preload does not count, and the chunk finished more than 3 seconds ago.
	done.advance(500);
	assert.equal(done.reloads, 1);

	// A background tab does not count.
	const hidden = loadPage();
	hidden.document.visibilityState = "hidden";
	hidden.advance(60_000);
	assert.equal(hidden.reloads, 0);
	hidden.document.visibilityState = "visible";
	hidden.advance(8_000);
	assert.equal(hidden.reloads, 1);
});

test("a page React runs, or one that is done loading, is left alone", () => {
	const cases = [
		{ flags: { [LOADER_MOUNTED_FLAG]: true } },
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
