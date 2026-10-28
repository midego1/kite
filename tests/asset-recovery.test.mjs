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
const { STALE_ASSETS_EVENT, assetRecoveryScript, markAppReady, takeStaleAssetsSignal } = await import(
	pathToFileURL(join(bundleDirectory, "recovery.mjs")).href
);
const ASSET_RELOAD_STORAGE_KEY = "kite:asset-reload";
const ASSET_RECOVERY_READY_FLAG = "__kiteAppReady";
const STALE_ASSETS_PENDING_FLAG = "__kiteStaleAssets";
const ASSET_RELOAD_WINDOW_MS = 120_000;
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
 * A page with the script in its <head>. Timers wait until `runTimers()`; storage survives `reload()`, which is
 * only counted. `clock.now` moves time.
 */
function loadPage({ storage = new Map(), clock = { now: 1_000_000 }, online = true, ready = false, dev = false } = {}) {
	const listeners = new Map();
	const timers = [];
	const page = { reloads: 0, waits: [], dispatched: [], errors: [], storage, clock };
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
		setTimeout: (callback, ms) => {
			page.waits.push(ms);
			timers.push(callback);
		},
		addEventListener: (type, listener) => listeners.set(type, [...(listeners.get(type) ?? []), listener]),
		dispatchEvent: (event) => page.dispatched.push(event.type),
	};
	sandbox.window = sandbox;
	if (ready) sandbox[ASSET_RECOVERY_READY_FLAG] = true;
	vm.runInNewContext(assetRecoveryScript({ dev }), sandbox);
	page.window = sandbox;
	page.fire = (type, event) => {
		for (const listener of listeners.get(type) ?? []) listener(event);
	};
	page.runTimers = () => {
		for (const callback of timers.splice(0)) callback();
	};
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
		if (attempt >= 4) assert.deepEqual(page.errors, ["[kite] The app's files could not be loaded after 4 reloads."]);
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
