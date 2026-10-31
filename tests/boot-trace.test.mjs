import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-boot-trace-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/components/boot-trace-utils.ts")],
	outfile: join(bundleDirectory, "trace.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	absWorkingDir: root,
	logLevel: "silent",
});
const { bootTraceScript, markBootPhase, readBootDetails } = await import(
	pathToFileURL(join(bundleDirectory, "trace.mjs")).href
);
const KEY = "kite-boot-trace";
const ORIGIN = "https://mail.example.com";

/**
 * A page with the script in its <head>: `clock.now` is `performance.now()`, storage survives into the next
 * `loadPage` with the same map, `observe(type, entries)` delivers PerformanceObserver entries and `fetches` holds
 * the original fetch's calls, each with `resolve`/`reject`.
 */
function loadPage({ storage = new Map(), path = "/inbox/abc?q=secret", clock = { now: 100 } } = {}) {
	const listeners = new Map();
	const observers = new Map();
	const disconnected = [];
	const selections = [];
	const fetches = [];
	const errors = [];
	const document = {
		visibilityState: "visible",
		createRange: () => ({
			selectNodeContents(node) {
				this.node = node;
			},
		}),
		execCommand: () => clock.execCopies ?? false,
	};
	const sandbox = {
		location: { href: `${ORIGIN}${path}`, origin: ORIGIN, pathname: path.split("?")[0] },
		performance: { now: () => clock.now },
		sessionStorage: {
			getItem: (key) => (storage.has(key) ? storage.get(key) : null),
			setItem: (key, value) => storage.set(key, String(value)),
		},
		console: { error: (message) => errors.push(message) },
		URL,
		document,
		PerformanceObserver: class {
			// Safari and Firefox have no long-animation-frame entries.
			static supportedEntryTypes = clock.noLoaf ? ["resource"] : ["resource", "long-animation-frame"];
			constructor(callback) {
				this.callback = callback;
			}
			observe({ type }) {
				if (type === "long-animation-frame" && clock.noLoaf) throw new TypeError("unsupported");
				this.type = type;
				observers.set(type, this.callback);
			}
			disconnect() {
				disconnected.push(this.type);
			}
		},
		navigator: {},
		// Copy details without the clipboard API: the text shown is selected and the browser asked to copy it.
		getSelection: () => ({
			removeAllRanges: () => selections.push("cleared"),
			addRange: (range) => selections.push(range.node),
		}),
		addEventListener: (type, listener) => listeners.set(type, [...(listeners.get(type) ?? []), listener]),
		fetch(input, init) {
			let resolve;
			let reject;
			const promise = new Promise((yes, no) => {
				resolve = yes;
				reject = no;
			});
			fetches.push({ input, init, promise, resolve, reject, self: this });
			return promise;
		},
	};
	sandbox.window = sandbox;
	vm.runInNewContext(bootTraceScript, sandbox);
	const trace = sandbox.__kiteBoot;
	return {
		window: sandbox,
		document,
		trace,
		storage,
		clock,
		errors,
		fetches,
		disconnected,
		selections,
		record: () => JSON.parse(storage.get(KEY)),
		// As plain objects of this realm, so deepEqual compares them.
		details: () => JSON.parse(JSON.stringify(trace.details())),
		fire: (type) => {
			for (const listener of listeners.get(type) ?? []) listener({ type });
		},
		observe: (type, entries) => observers.get(type)?.({ getEntries: () => entries }),
		// The watchdog's tick: `ms` later, with the visible time it counted so far.
		visibleMs: 0,
		beat(ms, visibleMs = this.visibleMs + ms) {
			clock.now += ms;
			this.visibleMs = visibleMs;
			trace.beat(visibleMs);
		},
	};
}

test("the trace records the phases a start reaches, once each, and counts the loader's mounts", () => {
	const page = loadPage();
	assert.deepEqual(page.record().phases, [{ p: "inline", t: 100 }]);
	// Only the first path segment, never the rest or the query string.
	assert.equal(page.record().page, "/inbox");
	page.clock.now = 400;
	page.trace.phase("loader-mounted");
	page.clock.now = 600;
	page.trace.phase("loader-mounted");
	page.trace.phase("auth-ready");
	page.trace.phase("no-such-phase");
	const record = page.record();
	assert.equal(record.mounts, 2);
	assert.deepEqual(
		record.phases.map((entry) => entry.p),
		["inline", "loader-mounted", "auth-ready"],
	);
	assert.equal(record.phases[1].t, 400);
	assert.equal(page.details().phase, "auth-ready");
	assert.equal(page.details().loaderMounts, 2);
	page.trace.remount(3);
	assert.equal(page.record().remounts, 3);
	assert.equal(page.details().overlayRemounts, 3);
	// Complete ends the trace: nothing more is written.
	page.trace.phase("complete");
	assert.equal(typeof page.record().ended, "number");
	page.beat(500);
	page.trace.phase("loader-mounted");
	assert.equal(page.record().mounts, 2);
});

test("a load whose heartbeat stopped while visible is reported by the next load, with its phase", () => {
	const storage = new Map();
	const frozen = loadPage({ storage });
	frozen.trace.phase("loader-mounted");
	frozen.beat(500);
	frozen.trace.phase("auth-ready");
	frozen.beat(500);
	// The main thread froze here: no more beats, no pagehide. The user reloads.
	const next = loadPage({ storage, clock: { now: 50 } });
	assert.deepEqual(next.errors, ["[kite] previous load froze at phase auth-ready after 1100 ms"]);
	assert.deepEqual(next.details().previousLoad, { phase: "auth-ready", afterMs: 1100, visibleMs: 1000 });
	assert.match(next.trace.text(), /^Previous load froze at auth-ready after 1\.1 s\n/);
	// The new load starts a record of its own, so a third load reports nothing.
	assert.deepEqual(next.record().phases, [{ p: "inline", t: 50 }]);
	next.trace.phase("complete");
	assert.deepEqual(loadPage({ storage }).errors, []);

	// A frozen thread that runs pagehide late (the browser waited for it) froze too.
	const late = new Map();
	const slow = loadPage({ storage: late });
	slow.beat(500);
	slow.clock.now += 9_000;
	slow.fire("pagehide");
	assert.equal(loadPage({ storage: late }).errors.length, 1);
});

test("a load that ended, left normally or was hidden is no freeze", () => {
	const cases = {
		complete: (page) => page.trace.phase("complete"),
		"ended by the watchdog": (page) => page.trace.end(),
		"left soon after a heartbeat": (page) => {
			page.clock.now += 300;
			page.fire("pagehide");
		},
		"hidden at its last heartbeat": (page) => {
			page.document.visibilityState = "hidden";
			page.fire("visibilitychange");
		},
	};
	for (const [label, finish] of Object.entries(cases)) {
		const storage = new Map();
		const page = loadPage({ storage });
		page.trace.phase("loader-mounted");
		page.beat(500);
		finish(page);
		const next = loadPage({ storage });
		assert.deepEqual(next.errors, [], label);
		assert.equal(next.details().previousLoad, null, label);
	}
	// A record from something else, or none, is ignored.
	for (const raw of [
		"not json",
		"null",
		"[]",
		JSON.stringify({ phases: "x", beat: 1 }),
		JSON.stringify({ phases: [null], beat: 1, visible: true }),
	]) {
		const page = loadPage({ storage: new Map([[KEY, raw]]) });
		assert.equal(typeof page.trace.details, "function", raw);
	}
});

test("a gap between visible heartbeats is kept as the longest stall", () => {
	const page = loadPage();
	page.trace.phase("loader-mounted");
	page.beat(500);
	page.beat(1_900);
	assert.equal(page.details().longestStall, null);
	page.beat(6_000, 3_400);
	page.trace.phase("auth-ready");
	page.beat(3_000, 4_400);
	assert.deepEqual(page.details().longestStall, { ms: 6_000, phase: "loader-mounted" });
	assert.equal(page.record().visibleMs, 4_400);
	// A gap while hidden is no stall.
	page.document.visibilityState = "hidden";
	page.fire("visibilitychange");
	page.beat(60_000, 4_400);
	assert.deepEqual(page.details().longestStall, { ms: 6_000, phase: "loader-mounted" });
});

test("requests still open are listed by path, without query strings, and fetch keeps its own promise", async () => {
	const page = loadPage();
	const first = page.window.fetch("/api/messages?mailboxId=1&q=private", { cache: "no-store" });
	page.clock.now += 1_000;
	page.window.fetch({ url: `${ORIGIN}/api/auth/me#x` });
	page.window.fetch(new URL("https://cdn.example.net/path/secret?token=1"));
	page.window.fetch("data:text/plain,hello");
	assert.equal(page.fetches.length, 4);
	assert.equal(first, page.fetches[0].promise);
	assert.deepEqual(page.fetches[0].init, { cache: "no-store" });
	page.clock.now += 500;
	assert.deepEqual(page.details().inFlight, [
		{ path: "/api/messages", startedAtMs: 100, ageMs: 1_500 },
		{ path: "/api/auth/me", startedAtMs: 1_100, ageMs: 500 },
		{ path: "https://cdn.example.net", startedAtMs: 1_100, ageMs: 500 },
		{ path: "data:", startedAtMs: 1_100, ageMs: 500 },
	]);
	page.fetches[0].resolve({ ok: true });
	page.fetches[1].reject(new TypeError("Failed to fetch"));
	await assert.rejects(page.fetches[1].promise);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(
		page.details().inFlight.map((entry) => entry.path),
		["https://cdn.example.net", "data:"],
	);
	assert.match(page.trace.text(), /In flight: https:\/\/cdn\.example\.net \(0\.5 s\), data: \(0\.5 s\)/);
	assert.doesNotMatch(JSON.stringify(page.details()), /secret|private|token|mailboxId/);
});

test("the five slowest files and frames over a second are kept, with their scripts but no query strings", () => {
	const page = loadPage();
	page.observe(
		"resource",
		[120, 900, 40, 3_000, 15, 700, 2_200].map((duration, index) => ({
			name: `${ORIGIN}/_next/static/chunks/${index}.js?v=${index}`,
			startTime: index * 10,
			duration,
		})),
	);
	assert.deepEqual(
		page.details().slowestResources.map((entry) => [entry.path, entry.durationMs]),
		[
			["/_next/static/chunks/3.js", 3_000],
			["/_next/static/chunks/6.js", 2_200],
			["/_next/static/chunks/1.js", 900],
			["/_next/static/chunks/5.js", 700],
			["/_next/static/chunks/0.js", 120],
		],
	);
	page.observe("long-animation-frame", [
		{ startTime: 200, duration: 900, blockingDuration: 850, scripts: [] },
		{
			startTime: 300.4,
			duration: 4_200.6,
			blockingDuration: 4_150,
			scripts: [
				{
					sourceURL: `${ORIGIN}/_next/static/chunks/inbox.js?x=1`,
					invoker: "Response.json.then",
					sourceFunctionName: "sanitize",
					duration: 10,
				},
				{
					sourceURL: `${ORIGIN}/_next/static/chunks/reader.js`,
					invoker: `${ORIGIN}/inbox?q=me@example.com`,
					sourceFunctionName: "linkify",
					duration: 4_100,
				},
			],
		},
	]);
	const [frame] = page.details().longFrames;
	assert.deepEqual(frame, {
		startMs: 300,
		durationMs: 4_201,
		blockingMs: 4_150,
		scripts: [
			{ source: "/_next/static/chunks/reader.js", invoker: `${ORIGIN}/inbox`, function: "linkify", durationMs: 4_100 },
			{ source: "/_next/static/chunks/inbox.js", invoker: "Response.json.then", function: "sanitize", durationMs: 10 },
		],
	});
	assert.equal(page.details().longFrames.length, 1);
	assert.match(
		page.trace.text(),
		/Long frame: 4\.2 s at 0\.3 s in \/_next\/static\/chunks\/reader\.js linkify via https:\/\/mail\.example\.com\/inbox/,
	);
	// Without long-animation-frame entries (Firefox, Safari) the rest still works.
	const plain = loadPage({ clock: { now: 0, noLoaf: true } });
	assert.deepEqual(plain.details().longFrames, []);
});

test("the details name the flags the watchdog reads, and the app's helpers do nothing without a trace", () => {
	const page = loadPage();
	page.window.__kiteLoaderMounted = true;
	const details = page.details();
	assert.equal(details.loaderMounted, true);
	assert.equal(details.ready, false);
	assert.match(page.trace.text(), /Loader mounted: yes, app ready: no/);

	assert.doesNotThrow(() => markBootPhase("auth-ready"));
	assert.equal(readBootDetails(), null);
	globalThis.window = page.window;
	try {
		markBootPhase("auth-ready");
		assert.equal(page.details().phase, "auth-ready");
		assert.equal(readBootDetails().details.phase, "auth-ready");
		assert.match(readBootDetails().text, /^Phase: auth-ready/);
		// A trace that throws never reaches the app.
		page.window.__kiteBoot = {
			phase: () => {
				throw new Error("broken");
			},
		};
		assert.doesNotThrow(() => markBootPhase("complete"));
		assert.equal(readBootDetails(), null);
	} finally {
		delete globalThis.window;
	}
});

test("the token of a link that grants access by itself is never kept", () => {
	const page = loadPage({ path: "/d/s3cretT0ken?pw=1" });
	assert.equal(page.record().page, "/d");
	page.window.fetch("/api/public/drive/s3cretT0ken/content?download=1");
	page.window.fetch("/api/public/drive/s3cretT0ken");
	page.window.fetch(`${ORIGIN}/api/shared-files/link-s3cret`);
	page.window.fetch("/api/drive/items/abc");
	page.observe("resource", [{ name: `${ORIGIN}/d/s3cretT0ken`, startTime: 0, duration: 900 }]);
	assert.deepEqual(
		page.details().inFlight.map((entry) => entry.path),
		[
			"/api/public/drive/:token/content",
			"/api/public/drive/:token",
			"/api/shared-files/:token",
			"/api/drive/items/abc",
		],
	);
	assert.deepEqual(
		page.details().slowestResources.map((entry) => entry.path),
		["/d/:token"],
	);
	assert.doesNotMatch(JSON.stringify(page.details()) + page.trace.text(), /s3cret|pw=|download/);
});

test("ending the trace disconnects its observers, and none for long frames is made where the browser has none", () => {
	const page = loadPage();
	page.trace.end();
	assert.deepEqual(page.disconnected, ["resource", "long-animation-frame"]);
	const plain = loadPage({ clock: { now: 0, noLoaf: true } });
	plain.trace.end();
	assert.deepEqual(plain.disconnected, ["resource"]);
});

test("Copy details copies the JSON, and without the clipboard API selects the text shown", async () => {
	const page = loadPage();
	const copied = [];
	page.window.navigator.clipboard = { writeText: async (text) => copied.push(text) };
	assert.equal(await page.trace.copy({ id: "pre" }), "copied");
	assert.equal(JSON.parse(copied[0]).phase, "inline");
	// Permission refused: the text is selected instead.
	page.window.navigator.clipboard = { writeText: async () => Promise.reject(new Error("denied")) };
	const pre = { id: "pre" };
	assert.equal(await page.trace.copy(pre), "selected");
	assert.deepEqual(page.selections, ["cleared", pre]);
	// Plain http: no clipboard API; the browser's own copy command still works.
	delete page.window.navigator.clipboard;
	page.clock.execCopies = true;
	assert.equal(await page.trace.copy(pre), "copied");
	assert.equal(await page.trace.copy(null), "failed");
});
