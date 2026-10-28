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
const { STALE_ASSETS_EVENT, assetRecoveryScript, markAppReady } = await import(
	pathToFileURL(join(bundleDirectory, "recovery.mjs")).href
);
const ASSET_RELOAD_STORAGE_KEY = "kite:asset-reload";
const ASSET_RECOVERY_READY_FLAG = "__kiteAppReady";
const ASSET_RELOAD_WINDOW_MS = 120_000;

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

/** A page with the script in its <head>: storage survives `reload()`, which records the wait it was scheduled with. */
function loadPage({ storage = new Map(), now = 1_000_000, online = true, ready = false } = {}) {
	const listeners = new Map();
	const page = { reloads: [], dispatched: [], errors: [], storage };
	const sandbox = {
		location: { href: "https://mail.example.com/inbox", origin: "https://mail.example.com", reload: () => {} },
		navigator: { onLine: online },
		sessionStorage: {
			getItem: (key) => (storage.has(key) ? storage.get(key) : null),
			setItem: (key, value) => storage.set(key, String(value)),
			removeItem: (key) => storage.delete(key),
		},
		console: { error: (message) => page.errors.push(message) },
		Date: { now: () => now },
		URL,
		JSON,
		String,
		Event: class {
			constructor(type) {
				this.type = type;
			}
		},
		HTMLScriptElement,
		HTMLLinkElement,
		setTimeout: (callback, ms) => {
			page.reloads.push(ms);
			callback();
		},
		addEventListener: (type, listener) => listeners.set(type, [...(listeners.get(type) ?? []), listener]),
		dispatchEvent: (event) => page.dispatched.push(event.type),
	};
	sandbox.window = sandbox;
	if (ready) sandbox[ASSET_RECOVERY_READY_FLAG] = true;
	vm.runInNewContext(assetRecoveryScript, sandbox);
	page.fire = (type, event) => {
		for (const listener of listeners.get(type) ?? []) listener(event);
	};
	page.state = () => JSON.parse(storage.get(ASSET_RELOAD_STORAGE_KEY) ?? "null");
	return page;
}

const missingEntry = { target: new HTMLScriptElement("https://mail.example.com/_next/static/chunks/index-new.js") };

test("a missing chunk before the app renders reloads after a growing wait, four times at most", () => {
	const storage = new Map();
	const waits = [];
	for (let attempt = 0; attempt < 6; attempt += 1) {
		const page = loadPage({ storage, now: 1_000_000 + attempt * 1_000 });
		page.fire("error", missingEntry);
		// A second failure on the same page schedules nothing more.
		page.fire("error", missingEntry);
		waits.push(...page.reloads);
		if (attempt >= 4) assert.match(page.errors.at(-1), /could not be loaded after 4 reloads/);
	}
	assert.deepEqual(waits, [1_000, 2_000, 4_000, 8_000]);
});

test("the count starts over after its window and once the app has rendered", () => {
	const storage = new Map([[ASSET_RELOAD_STORAGE_KEY, JSON.stringify({ count: 4, since: 1_000_000 })]]);
	const stale = loadPage({ storage, now: 1_000_000 + ASSET_RELOAD_WINDOW_MS + 1 });
	stale.fire("error", missingEntry);
	assert.deepEqual(stale.reloads, [1_000]);
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

test("module preloads, stylesheets and failed dynamic imports count; other origins, fonts and offline do not", () => {
	const ignored = [
		{ target: new HTMLScriptElement("https://challenges.cloudflare.com/turnstile/v0/api.js") },
		{ target: new HTMLLinkElement("preload", "https://mail.example.com/_next/static/font.woff2") },
		{ target: new HTMLScriptElement("") },
		{ target: {} },
	];
	for (const event of ignored) {
		const page = loadPage();
		page.fire("error", event);
		assert.deepEqual(page.reloads, []);
	}
	const offline = loadPage({ online: false });
	offline.fire("error", missingEntry);
	assert.deepEqual(offline.reloads, []);

	const counted = [
		["error", { target: new HTMLLinkElement("modulepreload", "/_next/static/chunks/providers-new.js") }],
		["error", { target: new HTMLLinkElement("stylesheet", "/_next/static/css/app-new.css") }],
		["vite:preloadError", {}],
		["unhandledrejection", { reason: new TypeError("Failed to fetch dynamically imported module: /x.js") }],
		["unhandledrejection", { reason: new TypeError("Importing a module script failed.") }],
	];
	for (const [type, event] of counted) {
		const page = loadPage();
		page.fire(type, event);
		assert.deepEqual(page.reloads, [1_000], type);
	}
	const unrelated = loadPage();
	unrelated.fire("unhandledrejection", { reason: new Error("Network request failed") });
	assert.deepEqual(unrelated.reloads, []);
});

test("after the app has rendered a missing chunk asks for an update check instead of reloading", () => {
	const page = loadPage({ ready: true });
	page.fire("vite:preloadError", {});
	page.fire("error", missingEntry);
	assert.deepEqual(page.reloads, []);
	assert.deepEqual(page.dispatched, [STALE_ASSETS_EVENT]);
	assert.equal(page.state(), null);
});

test("without working storage nothing could stop a loop, so it never reloads", () => {
	const page = loadPage({ storage: { has: () => false, get: () => null, set: () => {}, delete: () => {} } });
	page.fire("error", missingEntry);
	assert.deepEqual(page.reloads, []);
});
