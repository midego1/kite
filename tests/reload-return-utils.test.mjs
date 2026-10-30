import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-reload-return-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/components/reload-return-utils.ts")],
	outfile: join(bundleDirectory, "return.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	absWorkingDir: root,
	logLevel: "silent",
});
const {
	RELOAD_RETURN_ANNOUNCEMENT,
	RELOAD_RETURN_STATIC_TEXT,
	clearReloadReturnMarker,
	markReloadReturn,
	reloadReturnBootstrapScript,
} = await import(pathToFileURL(join(bundleDirectory, "return.mjs")).href);

/** What `reloadToNewVersion` writes and the inline script reads; the class the startup screen's CSS keys on. */
const RELOAD_RETURN_STORAGE_KEY = "kite-reload-flight";
const RELOAD_RETURN_CLASS = "kite-reload-return";
const NOW = 1_800_000_000_000;

function fakeStorage(entries = {}) {
	const map = new Map(Object.entries(entries));
	return {
		getItem: (key) => (map.has(key) ? map.get(key) : null),
		setItem: (key, value) => void map.set(key, String(value)),
		removeItem: (key) => void map.delete(key),
		map,
	};
}

/** Runs the inline <head> script against a fake sessionStorage and <html> class list; returns the classes it left. */
function runBootstrap({ storage = fakeStorage(), now = NOW, classes = [] } = {}) {
	const classList = new Set(classes);
	const context = vm.createContext({
		sessionStorage: storage,
		Date: { now: () => now },
		document: {
			documentElement: {
				classList: {
					add: (name) => void classList.add(name),
					contains: (name) => classList.has(name),
				},
			},
		},
	});
	vm.runInContext(reloadReturnBootstrapScript, context);
	return { classes: [...classList], storage };
}

/** Whether the boot script shows the return for a marker written `ageMs` ago (negative: by a clock that ran ahead). */
function returnsFor(ageMs) {
	const storage = fakeStorage({ [RELOAD_RETURN_STORAGE_KEY]: String(NOW - ageMs) });
	return runBootstrap({ storage }).classes.includes(RELOAD_RETURN_CLASS);
}

test("a marker counts for a minute, either way round the clock", () => {
	assert.equal(returnsFor(0), true);
	assert.equal(returnsFor(59_999), true);
	assert.equal(returnsFor(60_000), true);
	assert.equal(returnsFor(60_001), false, "older than a minute");
	// A clock that jumped back (or a marker written by a clock that ran ahead) is as stale as an old one.
	assert.equal(returnsFor(-1_000), true);
	assert.equal(returnsFor(-60_001), false);
});

test("markReloadReturn writes the time under the key the boot script reads, and clearing removes it", () => {
	const storage = fakeStorage();
	markReloadReturn(storage, NOW);
	assert.deepEqual([...storage.map], [[RELOAD_RETURN_STORAGE_KEY, String(NOW)]]);
	assert.deepEqual(runBootstrap({ storage, now: NOW + 5_000 }).classes, [RELOAD_RETURN_CLASS]);
	clearReloadReturnMarker(storage);
	assert.equal(storage.map.size, 0);
	assert.deepEqual(runBootstrap({ storage, now: NOW + 5_000 }).classes, []);
});

test("marking and clearing never throw without storage or with a storage that refuses", () => {
	assert.doesNotThrow(() => markReloadReturn(null, NOW));
	assert.doesNotThrow(() => clearReloadReturnMarker(null));
	const refusing = {
		getItem: () => null,
		setItem: () => {
			throw new Error("QuotaExceededError");
		},
		removeItem: () => {
			throw new Error("SecurityError");
		},
	};
	assert.doesNotThrow(() => markReloadReturn(refusing, NOW));
	assert.doesNotThrow(() => clearReloadReturnMarker(refusing));
});

test("the boot script adds the class for a fresh marker and keeps the marker until the app is up", () => {
	const storage = fakeStorage({ [RELOAD_RETURN_STORAGE_KEY]: String(NOW - 2_000) });
	const result = runBootstrap({ storage });
	assert.deepEqual(result.classes, [RELOAD_RETURN_CLASS]);
	// An automatic reload by the asset recovery within the minute shows the return again.
	assert.equal(storage.getItem(RELOAD_RETURN_STORAGE_KEY), String(NOW - 2_000));
});

test("the boot script leaves an ordinary load alone and removes a stale or broken marker", () => {
	assert.deepEqual(runBootstrap().classes, []);
	for (const raw of [String(NOW - 60_001), String(NOW + 120_000), "later", "NaN", "Infinity", ""]) {
		const storage = fakeStorage({ [RELOAD_RETURN_STORAGE_KEY]: raw });
		const result = runBootstrap({ storage });
		assert.deepEqual(result.classes, [], `${JSON.stringify(raw)} shows the plain screen`);
		assert.equal(storage.getItem(RELOAD_RETURN_STORAGE_KEY), null, `${JSON.stringify(raw)} is removed`);
	}
});

test("the boot script survives a page without sessionStorage", () => {
	const context = vm.createContext({
		get sessionStorage() {
			throw new Error("SecurityError: access is denied");
		},
		Date,
		document: { documentElement: { classList: { add: () => assert.fail("no class without a marker") } } },
	});
	assert.doesNotThrow(() => vm.runInContext(reloadReturnBootstrapScript, context));
});

test("the boot script only toggles a class: no DOM nodes the boot watchdog could count as progress", () => {
	assert.doesNotMatch(reloadReturnBootstrapScript, /createElement|append|innerHTML|insertAdjacent/);
	assert.match(reloadReturnBootstrapScript, /classList\.add/);
});

test("the screen's words", () => {
	assert.equal(RELOAD_RETURN_ANNOUNCEMENT, "Loading the new version…");
	assert.equal(RELOAD_RETURN_STATIC_TEXT, "Updating Kite…");
});
