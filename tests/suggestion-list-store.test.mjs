import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const outDir = makeBundleDirectory("kite-suggestion-list-store-");
after(() => rmSync(outDir, { recursive: true, force: true }));
await build({
	entryPoints: { store: fileURLToPath(import.meta.resolve("../src/hooks/suggestion-list-store.ts")) },
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	logLevel: "silent",
});
const { createSuggestionListStore, SUGGESTION_REFRESH_DEBOUNCE_MS } = await import(
	pathToFileURL(join(outDir, "store.mjs")).href
);

/** A store whose requests stay open until the test answers them, in order. */
function scriptedStore() {
	const requests = [];
	const fetchList = (url) =>
		new Promise((resolve) => requests.push({ url, answer: (json) => resolve(Response.json(json)) }));
	const store = createSuggestionListStore(fetchList, {
		setTimeout: (callback, ms) => setTimeout(callback, ms),
		clearTimeout: (handle) => clearTimeout(handle),
	});
	return { store, requests };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("readers of one URL share one refresh after a burst of events", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { store, requests } = scriptedStore();
	// The sidebar item and the empty reading pane read the same list.
	store.subscribe("/api/agent/suggestions", () => {});
	store.subscribe("/api/agent/suggestions", () => {});
	store.scheduleRefresh();
	t.mock.timers.tick(SUGGESTION_REFRESH_DEBOUNCE_MS - 1);
	store.scheduleRefresh();
	t.mock.timers.tick(SUGGESTION_REFRESH_DEBOUNCE_MS - 1);
	assert.equal(requests.length, 0);
	t.mock.timers.tick(1);
	assert.deepEqual(
		requests.map((r) => r.url),
		["/api/agent/suggestions"],
	);
});

test("a URL nobody reads any more is not refreshed", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { store, requests } = scriptedStore();
	const unsubscribe = store.subscribe("/api/agent/suggestions?messageId=a", () => {});
	store.scheduleRefresh();
	unsubscribe();
	t.mock.timers.tick(SUGGESTION_REFRESH_DEBOUNCE_MS);
	assert.equal(requests.length, 0);
});

test("an event during a request refetches once after it", async () => {
	const { store, requests } = scriptedStore();
	store.subscribe("/s", () => {});
	const first = store.load("/s");
	store.load("/s", true);
	store.load("/s", true);
	assert.equal(requests.length, 1);
	requests[0].answer({ suggestions: ["old"] });
	await first;
	await settle();
	assert.equal(requests.length, 2);
	requests[1].answer({ suggestions: ["new"] });
	await settle();
	await settle();
	assert.deepEqual(store.read("/s"), { suggestions: ["new"] });
});

test("a reader mounting right after an account switch starts its own request and shows its answer", async () => {
	const { store, requests } = scriptedStore();
	store.subscribe("/s", () => {});
	const old = store.load("/s");
	store.reset();
	// The new account's reader does not join the old request, whose answer would be thrown away.
	let shown = 0;
	store.subscribe("/s", () => (shown += 1));
	const next = store.load("/s");
	assert.equal(requests.length, 2);
	requests[1].answer({ suggestions: ["mine"] });
	await next;
	assert.deepEqual(store.read("/s"), { suggestions: ["mine"] });
	assert.equal(shown, 1);
	// The old answer arrives late: dropped, and it does not end the new session's bookkeeping.
	requests[0].answer({ suggestions: ["theirs"] });
	await old;
	assert.deepEqual(store.read("/s"), { suggestions: ["mine"] });
});

test("an old session's request settling late does not free a new one still running", async () => {
	const { store, requests } = scriptedStore();
	store.subscribe("/s", () => {});
	const old = store.load("/s");
	store.reset();
	store.load("/s");
	requests[0].answer({ suggestions: ["theirs"] });
	await old;
	// Still joined to the new session's request, not a third one.
	store.load("/s");
	assert.equal(requests.length, 2);
	assert.equal(store.read("/s"), undefined);
});

test("a reset clears what was shown and a pending refresh", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { store, requests } = scriptedStore();
	let notified = 0;
	store.subscribe("/s", () => (notified += 1));
	const loaded = store.load("/s");
	requests[0].answer({ suggestions: ["a"] });
	await loaded;
	store.scheduleRefresh();
	store.reset();
	assert.equal(store.read("/s"), undefined);
	assert.equal(notified, 2);
	t.mock.timers.tick(SUGGESTION_REFRESH_DEBOUNCE_MS);
	assert.equal(requests.length, 1);
});

test("signing in to another account reloads what is on screen; signing out only empties it", async () => {
	const { store, requests } = scriptedStore();
	let shown = 0;
	store.subscribe("/s", () => (shown += 1));
	store.subscribe("/s", () => {});
	const loaded = store.load("/s");
	requests[0].answer({ suggestions: ["a"] });
	await loaded;
	store.reset();
	assert.equal(requests.length, 1);
	store.reset({ reload: true });
	assert.deepEqual(
		requests.map((r) => r.url),
		["/s", "/s"],
	);
	requests[1].answer({ suggestions: ["b"] });
	await settle();
	await settle();
	assert.deepEqual(store.read("/s"), { suggestions: ["b"] });
	assert.equal(shown, 4);
});
