import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-draft-race-");
after(() => rmSync(outDir, { recursive: true, force: true }));

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://mail.example.com/" });
for (const key of [
	"window",
	"document",
	"HTMLElement",
	"HTMLInputElement",
	"Element",
	"Node",
	"Event",
	"localStorage",
]) {
	globalThis[key] = key === "window" ? dom.window : dom.window[key];
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

await build({
	entryPoints: [join(root, "src/components/compose/use-draft-autosave.ts")],
	outfile: join(outDir, "autosave.mjs"),
	bundle: true,
	platform: "browser",
	format: "esm",
	external: ["react", "react/*"],
	alias: { "@": join(root, "src") },
	logLevel: "silent",
});

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useDraftAutosave } = await import(pathToFileURL(join(outDir, "autosave.mjs")).href);

/** Mounts the hook against a fetch whose requests stay open until the test answers them. */
function mountAutosave(t) {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const container = document.createElement("div");
	document.body.appendChild(container);
	const reactRoot = createRoot(container);
	const fetchBefore = globalThis.fetch;
	let mounted = true;
	t.after(async () => {
		if (mounted) await act(async () => reactRoot.unmount());
		globalThis.fetch = fetchBefore;
		container.remove();
	});
	const requests = [];
	globalThis.fetch = (url, init) =>
		new Promise((resolve) => {
			requests.push({ method: init.method, subject: JSON.parse(init.body).subject, resolve });
		});
	const settle = () => new Promise((resolve) => setImmediate(resolve));
	const setters = { setDraftId() {}, setAttachments() {}, setStoredAttachments() {}, reportError() {} };
	let autosave;
	function Harness({ subject }) {
		autosave = useDraftAutosave({ payload: { subject }, attachments: [], storeAttachments: false }, setters);
		return null;
	}
	return {
		/** The subjects of the requests sent so far, in order. */
		sent: () => requests.map((request) => request.subject),
		/** Shows `subject` in the composer without waiting for the debounce. */
		show: (subject) => act(async () => reactRoot.render(createElement(Harness, { subject }))),
		/** Shows `subject` in the composer and lets the debounce run out. */
		async type(subject) {
			await this.show(subject);
			await act(async () => {
				t.mock.timers.tick(900);
				await settle();
			});
		},
		async answer(index, status = 200) {
			await act(async () => {
				requests[index].resolve(Response.json({ draft: { id: "draft_1" } }, { status }));
				await settle();
			});
		},
		async idle() {
			await act(async () => {
				t.mock.timers.tick(900);
				await settle();
			});
		},
		/** Starts a flush; it resolves once every save has finished, so it is not awaited. */
		flush: () => act(async () => void autosave.flush()),
		async close() {
			mounted = false;
			await act(async () => reactRoot.unmount());
			await act(async () => settle());
		},
	};
}

/** Saves A, then sends B and leaves it unanswered, the state the race needs. */
async function saveAThenSendB(t) {
	const composer = mountAutosave(t);
	await composer.type("A");
	await composer.answer(0);
	await composer.type("B");
	assert.deepEqual(composer.sent(), ["A", "B"]);
	return composer;
}

test("a revert made while a save is in flight is saved after it", async (t) => {
	const composer = await saveAThenSendB(t);
	await composer.type("A");
	assert.deepEqual(composer.sent(), ["A", "B"], "the revert waits in the queue behind B");
	await composer.answer(1);
	assert.deepEqual(composer.sent(), ["A", "B", "A"]);
	await composer.answer(2);
	await composer.idle();
	assert.deepEqual(composer.sent(), ["A", "B", "A"], "once the draft matches the composer nothing is saved again");
});

test("closing the composer before the revert's debounce ran still saves it", async (t) => {
	const composer = await saveAThenSendB(t);
	await composer.show("A");
	await composer.close();
	await composer.answer(1);
	assert.deepEqual(composer.sent(), ["A", "B", "A"]);
});

test("flush saves a revert made while a save is in flight", async (t) => {
	const composer = await saveAThenSendB(t);
	await composer.show("A");
	await composer.flush();
	await composer.answer(1);
	assert.deepEqual(composer.sent(), ["A", "B", "A"]);
});

test("equal content is saved again after a failed save", async (t) => {
	const composer = await saveAThenSendB(t);
	await composer.answer(1, 500);
	await composer.type("A");
	assert.deepEqual(composer.sent(), ["A", "B", "A"], "the draft may hold anything after the failure");
});

test("the same content shown again while its save is in flight is not queued twice", async (t) => {
	const composer = await saveAThenSendB(t);
	await composer.type("B");
	await composer.answer(1);
	await composer.idle();
	assert.deepEqual(composer.sent(), ["A", "B"]);
});
