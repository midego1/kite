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

test("a revert made while a save is in flight is saved after it", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const container = document.createElement("div");
	document.body.appendChild(container);
	const reactRoot = createRoot(container);
	const fetchBefore = globalThis.fetch;
	t.after(async () => {
		await act(async () => reactRoot.unmount());
		globalThis.fetch = fetchBefore;
		container.remove();
	});
	// Each request waits until the test answers it, so B can still be on the wire when the user reverts.
	const requests = [];
	globalThis.fetch = (url, init) =>
		new Promise((resolve) => {
			requests.push({ url, method: init.method, subject: JSON.parse(init.body).subject, resolve });
		});
	const answer = async (request) => {
		await act(async () => {
			request.resolve(Response.json({ draft: { id: "draft_1" } }));
			await new Promise((resolve) => setImmediate(resolve));
		});
	};
	const setters = { setDraftId() {}, setAttachments() {}, setStoredAttachments() {}, reportError() {} };
	let autosave;
	function Harness({ subject }) {
		autosave = useDraftAutosave({ payload: { subject }, attachments: [], storeAttachments: false }, setters);
		return null;
	}
	const type = async (subject) => {
		await act(async () => reactRoot.render(createElement(Harness, { subject })));
		await act(async () => {
			t.mock.timers.tick(900);
			await new Promise((resolve) => setImmediate(resolve));
		});
	};

	await type("A");
	assert.deepEqual(
		requests.map((request) => [request.method, request.subject]),
		[["POST", "A"]],
	);
	await answer(requests[0]);

	await type("B");
	assert.deepEqual(requests[1] && [requests[1].method, requests[1].subject], ["PATCH", "B"]);
	// The user reverts to A before the server answered: nothing new is queued yet.
	await type("A");
	assert.equal(requests.length, 2);

	await answer(requests[1]);
	await act(async () => {
		t.mock.timers.tick(900);
		await new Promise((resolve) => setImmediate(resolve));
	});
	assert.deepEqual(
		requests.map((request) => request.subject),
		["A", "B", "A"],
		"the server must end with what the composer shows",
	);
	await answer(requests[2]);
	await autosave.draftSaves.idle();
	t.mock.timers.tick(5000);
	assert.equal(requests.length, 3, "once the draft matches the composer nothing is saved again");
});
