import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-message-counts-");
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { useMessageCounts } from "./src/hooks/use-message-counts.ts";
			export { clearMessageClientState } from "./src/hooks/utils.ts";
		`,
		resolveDir: root,
		sourcefile: "message-counts-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	packages: "external",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});
const { useMessageCounts, clearMessageClientState } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

async function mount(t) {
	clearMessageClientState();
	const dom = new JSDOM("<div id='root'></div>", { url: "https://kite.test" });
	const previousGlobals = new Map();
	for (const [key, value] of Object.entries({
		window: dom.window,
		document: dom.window.document,
		localStorage: dom.window.localStorage,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	let visibility = "visible";
	Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
	const timers = new Map();
	let timerId = 0;
	t.mock.method(window, "setTimeout", (callback) => {
		timers.set(++timerId, callback);
		return timerId;
	});
	t.mock.method(window, "clearTimeout", (id) => timers.delete(id));
	let state;
	function Counts() {
		state = useMessageCounts();
		return null;
	}
	const mounted = createRoot(document.getElementById("root"));
	t.after(async () => {
		await act(() => mounted.unmount());
		dom.window.close();
		for (const [key, previous] of previousGlobals) {
			if (previous) Object.defineProperty(globalThis, key, previous);
			else delete globalThis[key];
		}
	});
	await act(() => mounted.render(createElement(Counts)));
	return {
		get state() {
			return state;
		},
		change: () => act(() => window.dispatchEvent(new dom.window.Event("kite:message-counts-changed"))),
		visibility: (value) =>
			act(() => {
				visibility = value;
				document.dispatchEvent(new dom.window.Event("visibilitychange"));
			}),
		refresh: () =>
			act(async () => {
				const callbacks = [...timers.values()];
				timers.clear();
				for (const callback of callbacks) callback();
			}),
	};
}

const answer = (unread) => Response.json({ counts: { folders: { inbox: { total: unread, unread } } } });

test("a hidden count invalidation refreshes on visibility without another message event", async (t) => {
	let unread = 8;
	const fetch = t.mock.method(globalThis, "fetch", async () => answer(unread));
	const hook = await mount(t);
	assert.equal(hook.state.counts.folders.inbox.unread, 8);
	await hook.visibility("hidden");
	unread = 3;
	await hook.change();
	await hook.change();
	assert.equal(fetch.mock.callCount(), 1, "hidden changes do not fetch");
	assert.equal(hook.state.isLoading, true, "the old account's count is no longer known");
	await hook.visibility("visible");
	await hook.refresh();
	assert.equal(fetch.mock.callCount(), 2, "hidden invalidations coalesce into one forced fetch");
	assert.equal(hook.state.counts.folders.inbox.unread, 3);
	assert.equal(hook.state.isLoading, false);
	await hook.visibility("hidden");
	await hook.visibility("visible");
	await hook.refresh();
	assert.equal(fetch.mock.callCount(), 2, "visibility alone does not refetch current counts");
});

test("an in-flight answer cannot restore counts invalidated while hidden", async (t) => {
	let finish;
	const fetch = t.mock.method(globalThis, "fetch", () => new Promise((resolve) => (finish = resolve)));
	const hook = await mount(t);
	await hook.visibility("hidden");
	await hook.change();
	await act(async () => finish(answer(12)));
	assert.equal(hook.state.counts.folders.inbox.unread, 0);
	assert.equal(hook.state.isLoading, true);
	await hook.visibility("visible");
	await hook.refresh();
	assert.equal(fetch.mock.callCount(), 2);
	await act(async () => finish(answer(4)));
	assert.equal(hook.state.counts.folders.inbox.unread, 4);
	assert.equal(hook.state.isLoading, false);
});
