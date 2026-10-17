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
const bundleDirectory = makeBundleDirectory("kite-hotkey-events-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/components/shortcuts/use-hotkeys.ts")],
	outfile: join(bundleDirectory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	packages: "external",
	logLevel: "silent",
});
const { useHotkeys } = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);

async function mount(t, shortcuts) {
	const dom = new JSDOM("<div id='root'></div>");
	const previousGlobals = new Map();
	for (const [key, value] of Object.entries({
		window: dom.window,
		document: dom.window.document,
		HTMLElement: dom.window.HTMLElement,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	function Shortcuts() {
		useHotkeys(shortcuts);
		return null;
	}
	const mounted = createRoot(dom.window.document.getElementById("root"));
	await act(() => mounted.render(createElement(Shortcuts)));
	t.after(async () => {
		await act(() => mounted.unmount());
		dom.window.close();
		for (const [key, previous] of previousGlobals) {
			if (previous) Object.defineProperty(globalThis, key, previous);
			else delete globalThis[key];
		}
	});
	return (key, modifiers = {}) => {
		const event = new dom.window.KeyboardEvent("keydown", { key, cancelable: true, ...modifiers });
		dom.window.dispatchEvent(event);
		return event.defaultPrevented;
	};
}

for (const modifier of ["ctrlKey", "metaKey", "altKey"]) {
	test(`${modifier} does not turn a browser chord into a plain shortcut`, async (t) => {
		let calls = 0;
		const press = await mount(t, [{ key: "c", action: () => calls++ }]);
		assert.equal(press("c", { [modifier]: true }), false);
		assert.equal(calls, 0);
	});
}

test("a plain single-key shortcut still runs", async (t) => {
	let calls = 0;
	const press = await mount(t, [{ key: "c", action: () => calls++ }]);
	assert.equal(press("c"), true);
	assert.equal(calls, 1);
});

test("multi-key shortcuts also check modifiers and still accept shifted punctuation", async (t) => {
	let calls = 0;
	const press = await mount(t, [
		{ key: "g i", action: () => calls++ },
		{ key: "g !", action: () => calls++ },
	]);
	press("g");
	assert.equal(press("i", { ctrlKey: true }), false);
	assert.equal(calls, 0);
	press("g");
	press("Shift", { shiftKey: true });
	assert.equal(press("!", { shiftKey: true }), true);
	assert.equal(calls, 1);
});
