import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test, { after } from "node:test";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { copyMigrationsBefore, migrationsDir } from "./support/module-database.mjs";
import { bundleModules } from "./support/modules-bundle.mjs";

const {
	SqliteDatabase,
	applyMigrations,
	createDb,
	LayoutPreferencesPendingError,
	readLayoutPreferences,
	saveLayoutPreferences,
	parseLayoutPatch,
	parseStoredLayout,
	layoutStorageEntries,
	withoutKeys,
} = await bundleModules("kite-layout-preferences-", [
	["SqliteDatabase", "server/runtime/sqlite-database.ts"],
	["applyMigrations", "server/runtime/migrate.ts"],
	["createDb", "src/db/index.ts"],
	["LayoutPreferencesPendingError, readLayoutPreferences, saveLayoutPreferences", "src/lib/preferences/layout.ts"],
	["parseLayoutPatch, parseStoredLayout", "src/lib/preferences/layout-utils.ts"],
	["layoutStorageEntries, withoutKeys", "src/components/layout-preferences-utils.ts"],
]);

const scratch = makeBundleDirectory("kite-layout-preferences-dirs-");
after(() => rmSync(scratch, { recursive: true, force: true }));
const preDirectory = copyMigrationsBefore(scratch, 80);

async function database(t, dir = migrationsDir) {
	const sqlite = new SqliteDatabase(":memory:");
	t.after(() => sqlite.db.close());
	await applyMigrations(sqlite, dir);
	sqlite.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES
			('owner', 'owner@example.com', 'hash', 'Owner', 1),
			('member', 'member@example.com', 'hash', 'Member', 1);
	`);
	return { sqlite, db: createDb(sqlite) };
}

test("a stored layout keeps only valid choices and clamps sizes", () => {
	const parseLayoutPreferences = (value) => parseStoredLayout(JSON.stringify(value));
	assert.deepEqual(
		parseLayoutPreferences({
			readingPane: "below",
			density: "compact",
			conversationView: false,
			listWidth: 480.6,
			listHeight: 5000,
			sidebar: "wide",
		}),
		{ readingPane: "below", density: "compact", conversationView: false, listWidth: 481, listHeight: 1200 },
	);
	assert.deepEqual(
		parseLayoutPreferences({ readingPane: "left", density: 3, conversationView: "off", listWidth: 10 }),
		{
			listWidth: 250,
		},
	);
	assert.deepEqual(parseLayoutPreferences({ listWidth: Number.NaN, listHeight: "300" }), {});
	for (const value of [null, "x", [], 4]) assert.deepEqual(parseLayoutPreferences(value), {});
});

test("parseStoredLayout reads JSON text and anything else as empty", () => {
	assert.deepEqual(parseStoredLayout('{"density":"comfortable"}'), { density: "comfortable" });
	assert.deepEqual(parseStoredLayout("not json"), {});
	assert.deepEqual(parseStoredLayout(null), {});
});

test("parseLayoutPatch needs a layout object with at least one valid choice", () => {
	assert.deepEqual(parseLayoutPatch({ layout: { readingPane: "none" } }), { readingPane: "none" });
	assert.equal(parseLayoutPatch({ layout: { readingPane: "sideways" } }), null);
	assert.equal(parseLayoutPatch({ readingPane: "none" }), null);
	assert.equal(parseLayoutPatch(null), null);
});

test("a layout maps to the browser storage the views read", () => {
	const layout = {
		readingPane: "below",
		density: "compact",
		conversationView: false,
		font: "opendyslexic",
		emailFont: "reader",
		fontScope: "everywhere",
		listWidth: 420,
		listHeight: 300,
	};
	const entries = layoutStorageEntries(layout, "user-1");
	assert.deepEqual(entries, [
		["kite-reading-pane", "below"],
		["kite-message-density", "compact"],
		["kite-conversation-view", "off"],
		["kite-font", "opendyslexic"],
		["kite-email-font", "reader"],
		["kite-font-scope", "everywhere"],
		["kite-column-width:message-list", "420"],
		["kite-column-width:message-list:user-1", "420"],
		["kite-column-width:message-list-height", "300"],
		["kite-column-width:message-list-height:user-1", "300"],
	]);
	assert.deepEqual(layoutStorageEntries({}, "user-1"), []);
});

test("withoutKeys leaves out choices made here and not saved yet", () => {
	assert.deepEqual(withoutKeys({ readingPane: "none", density: "compact" }, { density: "default" }), {
		readingPane: "none",
	});
});

test("an account without a saved layout reads as null, and saving merges choices", async (t) => {
	const { db, sqlite } = await database(t);
	assert.deepEqual(await readLayoutPreferences(db, "owner"), { ready: true, layout: null });

	assert.deepEqual(await saveLayoutPreferences(db, "owner", { readingPane: "below" }), { readingPane: "below" });
	assert.deepEqual(await saveLayoutPreferences(db, "owner", { density: "compact", listWidth: 400 }), {
		readingPane: "below",
		density: "compact",
		listWidth: 400,
	});
	assert.deepEqual(await saveLayoutPreferences(db, "owner", { readingPane: "none" }), {
		readingPane: "none",
		density: "compact",
		listWidth: 400,
	});
	assert.deepEqual(await readLayoutPreferences(db, "owner"), {
		ready: true,
		layout: { readingPane: "none", density: "compact", listWidth: 400 },
	});
	// Each account has its own.
	assert.deepEqual(await readLayoutPreferences(db, "member"), { ready: true, layout: null });

	// Deleting the account deletes its layout.
	sqlite.db.exec("PRAGMA foreign_keys = ON; DELETE FROM users WHERE id = 'owner'");
	assert.deepEqual(sqlite.db.prepare("SELECT count(*) AS n FROM user_preferences").get(), { n: 0 });
});

test("before migration 0080 the layout reads as not ready and saving is refused", async (t) => {
	const { db } = await database(t, preDirectory);
	assert.deepEqual(await readLayoutPreferences(db, "owner"), { ready: false, layout: null });
	await assert.rejects(saveLayoutPreferences(db, "owner", { density: "compact" }), LayoutPreferencesPendingError);
});

const {
	flushLayoutSave,
	isRetryableLayoutLoad,
	queueLayoutSave,
	startLayoutSync,
	stopLayoutSync,
	withoutSavedSince,
	LAYOUT_LOAD_RETRY_DELAYS_MS,
} = await bundleModules("kite-layout-preferences-client-", [
	["flushLayoutSave, queueLayoutSave, startLayoutSync, stopLayoutSync", "src/components/layout-preferences-client.ts"],
	[
		"isRetryableLayoutLoad, withoutSavedSince, LAYOUT_LOAD_RETRY_DELAYS_MS",
		"src/components/layout-preferences-utils.ts",
	],
]);

test("withoutSavedSince leaves out choices saved after the load started or still in flight", () => {
	const layout = { readingPane: "none", density: "compact", font: "serif" };
	const marks = new Map([
		["readingPane", { touched: 2, inFlight: 0 }],
		["density", { touched: 5, inFlight: 0 }],
		["font", { touched: 1, inFlight: 1 }],
	]);
	assert.deepEqual(withoutSavedSince(layout, marks, 3), { readingPane: "none" });
	assert.deepEqual(withoutSavedSince(layout, new Map(), 3), layout);
});

test("only network, server and rate-limit failures retry a layout load", () => {
	assert.equal(isRetryableLayoutLoad(null), true);
	assert.equal(isRetryableLayoutLoad(503), true);
	assert.equal(isRetryableLayoutLoad(429), true);
	assert.equal(isRetryableLayoutLoad(401), false);
	assert.equal(isRetryableLayoutLoad(404), false);
});

/** A browser with storage and a scripted `/api/settings/layout`, for the sync client. */
function fakeBrowser(t, answerGet, answerPatch = () => null) {
	const storage = new Map();
	const requests = [];
	const previous = { window: globalThis.window, fetch: globalThis.fetch };
	globalThis.window = {
		localStorage: {
			getItem: (key) => storage.get(key) ?? null,
			setItem: (key, value) => storage.set(key, String(value)),
			removeItem: (key) => storage.delete(key),
		},
		dispatchEvent: () => true,
	};
	globalThis.fetch = async (_url, init = {}) => {
		const method = init.method ?? "GET";
		requests.push({ method, body: init.body ? JSON.parse(init.body) : undefined });
		const count = requests.filter((r) => r.method === method).length;
		const answer = await (method === "GET" ? answerGet(count) : answerPatch(count));
		if (answer instanceof Error) throw answer;
		const { status = 200, json = { ready: true, layout: null } } = answer ?? {};
		return new Response(JSON.stringify(json), { status });
	};
	t.after(() => {
		stopLayoutSync();
		globalThis.window = previous.window;
		globalThis.fetch = previous.fetch;
	});
	return { storage, requests };
}

test("a failed first load is retried, and choices are saved once every attempt failed", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { requests } = fakeBrowser(t, () => ({ status: 503, json: { error: "down" } }));
	const started = startLayoutSync("user-retry");
	queueLayoutSave({ density: "compact" });
	for (const delay of LAYOUT_LOAD_RETRY_DELAYS_MS) {
		await new Promise((resolve) => setImmediate(resolve));
		t.mock.timers.tick(delay);
	}
	await started;
	assert.equal(requests.filter((r) => r.method === "GET").length, LAYOUT_LOAD_RETRY_DELAYS_MS.length + 1);
	assert.deepEqual(
		requests.filter((r) => r.method === "PATCH").map((r) => r.body),
		[{ layout: { density: "compact" } }],
	);
});

test("a load that succeeds on a retry applies the account's layout", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { storage } = fakeBrowser(t, (count) =>
		count === 1 ? new TypeError("offline") : { json: { ready: true, layout: { density: "compact" } } },
	);
	const started = startLayoutSync("user-retry-ok");
	await new Promise((resolve) => setImmediate(resolve));
	t.mock.timers.tick(LAYOUT_LOAD_RETRY_DELAYS_MS[0]);
	await started;
	assert.equal(storage.get("kite-message-density"), "compact");
});

test("a load answered after a save does not put the saved choice back", async (t) => {
	let answerLoad;
	let answerSave;
	const { storage } = fakeBrowser(
		t,
		(count) =>
			count === 1 ? { json: { ready: true, layout: null } } : new Promise((resolve) => (answerLoad = resolve)),
		() => new Promise((resolve) => (answerSave = resolve)),
	);
	await startLayoutSync("user-stale");
	queueLayoutSave({ density: "comfortable" });
	const saved = flushLayoutSave();
	// The tab comes back while the save is in flight; the server reads the layout before it writes the save.
	const refresh = startLayoutSync("user-stale");
	await new Promise((resolve) => setImmediate(resolve));
	answerSave(null);
	await saved;
	answerLoad({ json: { ready: true, layout: { density: "compact", readingPane: "none" } } });
	await refresh;
	assert.equal(storage.get("kite-message-density"), undefined);
	assert.equal(storage.get("kite-reading-pane"), "none");
});

test("a not-ready answer stops loading and saving for the rest of the page load", async (t) => {
	const { requests } = fakeBrowser(t, () => ({ json: { ready: false, layout: null } }));
	await startLayoutSync("user-pending");
	queueLayoutSave({ density: "compact" });
	await flushLayoutSave();
	await startLayoutSync("user-pending");
	assert.deepEqual(
		requests.map((r) => r.method),
		["GET"],
	);
});

test("a load answered after sync was switched off on this device leaves the layout alone", async (t) => {
	let answerLoad;
	const { storage } = fakeBrowser(t, () => new Promise((resolve) => (answerLoad = resolve)));
	const started = startLayoutSync("user-off");
	await new Promise((resolve) => setImmediate(resolve));
	storage.set("kite-layout-sync", "off");
	answerLoad({ json: { ready: true, layout: { density: "compact" } } });
	await started;
	assert.equal(storage.get("kite-message-density"), undefined);
});

test("a page closing while the layout loads still saves the choices made meanwhile", async (t) => {
	let answerLoad;
	const { storage, requests } = fakeBrowser(t, () => new Promise((resolve) => (answerLoad = resolve)));
	const started = startLayoutSync("user-closing");
	await new Promise((resolve) => setImmediate(resolve));
	queueLayoutSave({ density: "comfortable" });
	await flushLayoutSave();
	assert.deepEqual(
		requests.map((r) => r.method),
		["GET"],
	);
	await flushLayoutSave({ closing: true });
	assert.deepEqual(
		requests.filter((r) => r.method === "PATCH").map((r) => r.body),
		[{ layout: { density: "comfortable" } }],
	);
	// The load read the layout before the save landed; it must not put the old choice back.
	answerLoad({ json: { ready: true, layout: { density: "compact" } } });
	await started;
	assert.equal(storage.get("kite-message-density"), undefined);
});

test("a save answered after an account switch does not hold back the next account's layout", async (t) => {
	let answerSave;
	let answerLoad;
	const { storage } = fakeBrowser(
		t,
		(count) =>
			count === 1 ? { json: { ready: true, layout: null } } : new Promise((resolve) => (answerLoad = resolve)),
		() => new Promise((resolve) => (answerSave = resolve)),
	);
	await startLayoutSync("user-first");
	queueLayoutSave({ density: "comfortable" });
	const saved = flushLayoutSave();
	stopLayoutSync();
	const next = startLayoutSync("user-second");
	await new Promise((resolve) => setImmediate(resolve));
	answerSave(null);
	await saved;
	answerLoad({ json: { ready: true, layout: { density: "compact" } } });
	await next;
	assert.equal(storage.get("kite-message-density"), "compact");
});

test("signing out and back in while a save is in flight keeps a quick load from putting the old choice back", async (t) => {
	let answerSave;
	let answerLoad;
	const { storage } = fakeBrowser(
		t,
		(count) =>
			count === 1 ? { json: { ready: true, layout: null } } : new Promise((resolve) => (answerLoad = resolve)),
		() => new Promise((resolve) => (answerSave = resolve)),
	);
	await startLayoutSync("user-again");
	queueLayoutSave({ density: "comfortable" });
	const saved = flushLayoutSave();
	stopLayoutSync();
	// The same account signs in again; the server reads the layout before it writes the save.
	const again = startLayoutSync("user-again");
	await new Promise((resolve) => setImmediate(resolve));
	answerLoad({ json: { ready: true, layout: { density: "compact", readingPane: "none" } } });
	await again;
	answerSave(null);
	await saved;
	assert.equal(storage.get("kite-message-density"), undefined);
	assert.equal(storage.get("kite-reading-pane"), "none");
});

test("signing out forgets a not-ready answer, so the next session asks again", async (t) => {
	const { requests } = fakeBrowser(t, (count) => ({ json: { ready: count > 1, layout: null } }));
	await startLayoutSync("user-later");
	stopLayoutSync();
	await startLayoutSync("user-later");
	queueLayoutSave({ density: "compact" });
	await flushLayoutSave();
	assert.deepEqual(
		requests.map((r) => r.method),
		["GET", "GET", "PATCH"],
	);
});

test("a refusal answered after an account switch does not stop the next account's saves", async (t) => {
	let refuse;
	const { requests } = fakeBrowser(
		t,
		() => ({ json: { ready: true, layout: null } }),
		(count) => (count === 1 ? new Promise((resolve) => (refuse = resolve)) : null),
	);
	await startLayoutSync("user-before");
	queueLayoutSave({ density: "compact" });
	const refused = flushLayoutSave();
	stopLayoutSync();
	await startLayoutSync("user-after");
	refuse({ status: 409, json: { error: "pending" } });
	await refused;
	queueLayoutSave({ density: "comfortable" });
	await flushLayoutSave();
	assert.deepEqual(
		requests.filter((r) => r.method === "PATCH").map((r) => r.body),
		[{ layout: { density: "compact" } }, { layout: { density: "comfortable" } }],
	);
});
