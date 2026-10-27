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

// Upstream Mailflare #161: browser and OS chords must never reach a single-key shortcut or a sequence.
for (const [key, modifiers] of [
	["c", { metaKey: true }],
	["c", { ctrlKey: true }],
	["r", { metaKey: true }],
	["f", { metaKey: true }],
	["f", { ctrlKey: true }],
]) {
	test(`${Object.keys(modifiers)[0]}+${key} is left to the browser`, async (t) => {
		let calls = 0;
		const press = await mount(t, [
			{ key: "c", action: () => calls++ },
			{ key: "r", action: () => calls++ },
			{ key: "f", action: () => calls++ },
		]);
		assert.equal(press(key, modifiers), false);
		assert.equal(calls, 0);
	});
}

test("a chord's key is not the first step of a sequence", async (t) => {
	let calls = 0;
	const press = await mount(t, [{ key: "g i", action: () => calls++ }]);
	for (const modifiers of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
		press("g", modifiers);
		assert.equal(press("i"), false);
	}
	assert.equal(calls, 0);
	press("g");
	assert.equal(press("i"), true);
	assert.equal(calls, 1);
});

for (const modifier of ["metaKey", "ctrlKey", "altKey"]) {
	test(`${modifier} cancels a pending sequence and its timer`, async (t) => {
		let calls = 0;
		const press = await mount(t, [{ key: "g i", action: () => calls++ }]);
		const clear = t.mock.method(globalThis, "clearTimeout");
		press("g");
		assert.equal(press("c", { [modifier]: true }), false);
		assert.equal(clear.mock.callCount(), 1);
		assert.equal(press("i"), false);
		assert.equal(calls, 0, "the chord interrupted g i");
		press("g");
		assert.equal(press("i"), true);
		assert.equal(calls, 1, "a new uninterrupted sequence still works");
	});
}

test("Cmd or Ctrl with a punctuation shortcut is left to the browser", async (t) => {
	const calls = [];
	const press = await mount(t, [
		{ key: "?", action: () => calls.push("?") },
		{ key: "/", action: () => calls.push("/") },
		{ key: "#", action: () => calls.push("#") },
	]);
	assert.equal(press("?", { metaKey: true, shiftKey: true }), false);
	assert.equal(press("/", { ctrlKey: true }), false);
	assert.equal(press("#", { metaKey: true, shiftKey: true }), false);
	assert.deepEqual(calls, []);
});

test("Shift still types ?, # and the ! of g !", async (t) => {
	const calls = [];
	const press = await mount(t, [
		{ key: "?", action: () => calls.push("?") },
		{ key: "#", action: () => calls.push("#") },
		{ key: "g !", action: () => calls.push("g !") },
	]);
	assert.equal(press("?", { shiftKey: true }), true);
	assert.equal(press("#", { shiftKey: true }), true);
	press("g");
	press("Shift", { shiftKey: true });
	assert.equal(press("!", { shiftKey: true }), true);
	assert.deepEqual(calls, ["?", "#", "g !"]);
});

test("a character typed with AltGr or Option is the character, not a chord", async (t) => {
	const calls = [];
	const press = await mount(t, [
		{ key: "#", action: () => calls.push("#") },
		{ key: "/", action: () => calls.push("/") },
		{ key: "c", action: () => calls.push("c") },
	]);
	// AltGr arrives as Ctrl+Alt on Windows: `#` on French AZERTY, `/` on some Nordic layouts. Option+3 is `#` on a British Mac.
	assert.equal(press("#", { ctrlKey: true, altKey: true }), true);
	assert.equal(press("/", { ctrlKey: true, altKey: true, shiftKey: true }), true);
	assert.equal(press("#", { altKey: true }), true);
	// Characters that are not shortcuts pass through untouched.
	assert.equal(press("@", { ctrlKey: true, altKey: true }), false);
	assert.equal(press("€", { ctrlKey: true, altKey: true }), false);
	// A letter with Ctrl+Alt is a chord, not a typed character.
	assert.equal(press("c", { ctrlKey: true, altKey: true }), false);
	assert.deepEqual(calls, ["#", "/", "#"]);
});

test("Cmd+K and Ctrl+K still open the command palette", async (t) => {
	let calls = 0;
	const press = await mount(t, [
		{ key: "k", modifiers: ["meta", "ctrl"], action: () => calls++ },
		{ key: "c", action: () => calls++ },
	]);
	assert.equal(press("k", { metaKey: true }), true);
	assert.equal(press("k", { ctrlKey: true }), true);
	assert.equal(calls, 2);
});

test("bare keys stay with the composer, dialogs and comboboxes that have the focus", async (t) => {
	let calls = 0;
	await mount(t, [
		{ key: "e", action: () => calls++ },
		{ key: "g i", action: () => calls++ },
	]);
	const zones = [
		'<form data-shortcuts-off><button type="button">Bold</button></form>',
		'<div role="dialog"><button type="button">OK</button></div>',
		'<div role="alertdialog"><button type="button">Delete</button></div>',
		'<div aria-modal="true"><button type="button">Close</button></div>',
		'<button type="button" role="combobox">Style</button>',
	];
	for (const markup of zones) {
		const holder = document.createElement("div");
		holder.innerHTML = markup;
		document.body.appendChild(holder);
		const target = holder.querySelector("button");
		for (const key of ["e", "g", "i"]) {
			const event = new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
			target.dispatchEvent(event);
			assert.equal(event.defaultPrevented, false, `${key} in ${markup}`);
		}
		holder.remove();
	}
	assert.equal(calls, 0);

	const outside = document.createElement("button");
	document.body.appendChild(outside);
	const event = new window.KeyboardEvent("keydown", { key: "e", bubbles: true, cancelable: true });
	outside.dispatchEvent(event);
	assert.equal(calls, 1, "a focused button elsewhere still gets the shortcut");
});
