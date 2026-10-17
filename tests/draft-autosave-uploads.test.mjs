import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-draft-uploads-");
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

async function autosaveUploads(t, failure) {
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
	const file = { id: "local-file", file: new File(["Agenda"], "agenda.txt", { type: "text/plain" }) };
	const attachment = { id: "stored-file", filename: "agenda.txt", size: 6 };
	let attempts = 0;
	globalThis.fetch = async (url) => {
		if (url.endsWith("/attachments")) {
			attempts += 1;
			if (attempts === 1) {
				if (failure === "network") throw new TypeError("Failed to fetch");
				return Response.json({ error: "Upload failed" }, { status: failure });
			}
			return Response.json({ attachments: [attachment] });
		}
		return Response.json({ draft: { id: "draft_1" } });
	};
	const errors = [];
	const ids = [];
	let files = [file];
	let stored = [];
	let autosave;
	const setters = {
		setDraftId: (id) => ids.push(id),
		setAttachments: (update) => (files = update(files)),
		setStoredAttachments: (update) => (stored = update(stored)),
		reportError: (error) => errors.push(error),
	};
	function Harness({ snapshot }) {
		autosave = useDraftAutosave(snapshot, setters);
		return null;
	}
	async function save(subject) {
		await act(async () => {
			reactRoot.render(
				createElement(Harness, { snapshot: { payload: { subject }, attachments: files, storeAttachments: true } }),
			);
		});
		await act(async () => {
			t.mock.timers.tick(900);
			await autosave.draftSaves.idle();
		});
	}
	await save("First edit");
	assert.equal(attempts, 1);
	assert.equal(errors.length, 1);
	assert.match(errors[0].message, /Could not save the attachments/);
	assert.deepEqual(files, [file], "failed files remain available for sending");
	assert.deepEqual(stored, []);
	await save("Later edit");
	return { attempts, files, stored, ids, storedUploads: autosave.storedUploads, attachment };
}

for (const failure of ["network", 408, 429, 503]) {
	test(`a later autosave retries attachments after ${failure}`, async (t) => {
		const result = await autosaveUploads(t, failure);
		assert.equal(result.attempts, 2);
		assert.deepEqual(result.files, []);
		assert.deepEqual(result.stored, [result.attachment]);
		assert.deepEqual(result.ids, ["draft_1"]);
		assert.equal(result.storedUploads.has("local-file"), true);
	});
}

for (const status of [400, 413]) {
	test(`a later autosave does not retry files refused with ${status}`, async (t) => {
		const result = await autosaveUploads(t, status);
		assert.equal(result.attempts, 1);
		assert.equal(result.files.length, 1);
		assert.deepEqual(result.stored, []);
		assert.equal(result.storedUploads.size, 0);
	});
}
