import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-app-badge-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `export * from "./src/lib/app-badge-utils.ts";
export { clearClientSessionKey, setClientSessionKey } from "./src/lib/auth/client.ts";`,
		resolveDir: root,
		sourcefile: "app-badge-entry.ts",
		loader: "ts",
	},
	outfile: join(bundleDirectory, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});
const { applyAppBadge, clearAppBadge, clearClientSessionKey, knownInboxUnread, supportsAppBadge } = await import(
	pathToFileURL(join(bundleDirectory, "entry.mjs")).href
);

function fakeNavigator({ reject = false, throwSync = false } = {}) {
	const calls = [];
	const fail = (call) => {
		calls.push(call);
		if (throwSync) throw new Error("not an installed app");
		return reject ? Promise.reject(new DOMException("not allowed", "NotAllowedError")) : Promise.resolve();
	};
	return {
		calls,
		setAppBadge: (count) => fail(["set", count]),
		clearAppBadge: () => fail(["clear"]),
	};
}

const counts = (unread) => ({ folders: { inbox: { total: 20, unread } } });

test("the badge is supported only when both Badging API methods exist", () => {
	assert.equal(supportsAppBadge(fakeNavigator()), true);
	assert.equal(supportsAppBadge({ setAppBadge: async () => {} }), false);
	assert.equal(supportsAppBadge({}), false);
	assert.equal(supportsAppBadge(undefined), false);
	assert.equal(supportsAppBadge(null), false);
});

test("the badge count is a whole, non-negative number", async () => {
	const nav = fakeNavigator();
	for (const unread of [7, 2.9, 0, -3, Number.NaN, Number.POSITIVE_INFINITY, "4", undefined]) {
		await applyAppBadge(nav, unread);
	}
	assert.deepEqual(nav.calls, [
		["set", 7],
		["set", 2],
		["clear"],
		["clear"],
		["clear"],
		["clear"],
		["clear"],
		["clear"],
	]);
	const placeholder = counts(0);
	assert.equal(knownInboxUnread(counts(3.5), placeholder, false), 3);
	assert.equal(knownInboxUnread(counts(-1), placeholder, false), 0);
});

test("an unread count sets the badge and zero clears it", async () => {
	const nav = fakeNavigator();
	await applyAppBadge(nav, 5);
	await applyAppBadge(nav, 0);
	await applyAppBadge(nav, -1);
	await clearAppBadge(nav);
	assert.deepEqual(nav.calls, [["set", 5], ["clear"], ["clear"], ["clear"]]);
});

test("a browser without the Badging API is left alone", async () => {
	await applyAppBadge({}, 3);
	await applyAppBadge(undefined, 3);
	await clearAppBadge(null);
});

test("a rejected or throwing badge update is swallowed", async () => {
	for (const options of [{ reject: true }, { throwSync: true }]) {
		const nav = fakeNavigator(options);
		await applyAppBadge(nav, 2);
		await clearAppBadge(nav);
		assert.deepEqual(nav.calls, [["set", 2], ["clear"]]);
	}
});

test("only a loaded answer, not the placeholder, gives the badge count", () => {
	const placeholder = counts(0);
	assert.equal(knownInboxUnread(placeholder, placeholder, false), null);
	assert.equal(knownInboxUnread(placeholder, placeholder, true), null);
	assert.equal(knownInboxUnread(counts(4), placeholder, true), null);
	assert.equal(knownInboxUnread(counts(4), placeholder, false), 4);
	assert.equal(knownInboxUnread(counts(0), placeholder, false), 0);
});

test("signing out clears the app badge", async (t) => {
	const nav = fakeNavigator();
	const storage = new Map([["kite-session-user", "user-1"]]);
	const globals = {
		navigator: nav,
		localStorage: {
			getItem: (key) => storage.get(key) ?? null,
			setItem: (key, value) => storage.set(key, String(value)),
			removeItem: (key) => storage.delete(key),
		},
		window: { dispatchEvent: () => true },
	};
	const previous = new Map();
	for (const [key, value] of Object.entries(globals)) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	t.after(() => {
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globalThis[key];
		}
	});

	clearClientSessionKey();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(storage.has("kite-session-user"), false);
	assert.deepEqual(nav.calls, [["clear"]]);
});
