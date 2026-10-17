import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-insert-link-");
after(() => rmSync(outDir, { recursive: true, force: true }));

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://mail.example.com/" });
for (const key of ["window", "document", "HTMLElement", "HTMLInputElement", "Element", "Node", "Event"]) {
	globalThis[key] = key === "window" ? dom.window : dom.window[key];
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
document.queryCommandState = () => false;
document.queryCommandValue = () => "";

await build({
	entryPoints: [join(root, "src/components/compose/rich-text-editor.tsx")],
	outfile: join(outDir, "editor.mjs"),
	bundle: true,
	platform: "browser",
	format: "esm",
	jsx: "automatic",
	external: ["react", "react-dom", "react-dom/*", "react/*"],
	alias: { "@": join(root, "src") },
	logLevel: "silent",
});

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { RichTextEditor } = await import(pathToFileURL(join(outDir, "editor.mjs")).href);

/** Renders the editor inside a form, as the composer does, and opens the Insert link popup. */
async function openLinkPopup(t) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const reactRoot = createRoot(container);
	t.after(async () => {
		await act(async () => reactRoot.unmount());
		container.remove();
	});
	let submits = 0;
	let formKeys = 0;
	const commands = [];
	document.execCommand = (command, _showUi, value) => {
		commands.push({ command, value, selection: window.getSelection().toString() });
		return true;
	};
	const onSubmit = (event) => {
		event.preventDefault();
		submits += 1;
	};
	await act(async () => {
		reactRoot.render(
			createElement(
				"form",
				{ onSubmit, onKeyDown: () => (formKeys += 1) },
				createElement(RichTextEditor, { value: "Read this", onChange() {} }),
			),
		);
	});
	const editor = container.querySelector('[role="textbox"]');
	editor.focus();
	const range = document.createRange();
	range.setStart(editor.firstChild, 9);
	range.setEnd(editor.firstChild, 9);
	window.getSelection().removeAllRanges();
	window.getSelection().addRange(range);
	await act(async () => container.querySelector('[aria-label="Insert link"]').click());
	const input = container.querySelector('input[placeholder="https://example.com"]');
	assert.ok(input, "the popup opens");
	assert.equal(container.querySelectorAll("form").length, 1, "the popup must not nest a form inside the composer");

	return {
		commands,
		submits: () => submits,
		formKeys: () => formKeys,
		popupOpen: () => !!container.querySelector('input[placeholder="https://example.com"]'),
		async type(value) {
			await act(async () => {
				Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, value);
				input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
			});
		},
		async press(key, { apply = false, isComposing = false } = {}) {
			const event = new dom.window.KeyboardEvent("keydown", { key, isComposing, bubbles: true, cancelable: true });
			const target = apply
				? Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Apply")
				: input;
			target.focus();
			await act(async () => target.dispatchEvent(event));
			return event;
		},
		async clickApply() {
			const apply = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Apply");
			assert.equal(apply.type, "button", "Apply must not be a submit button");
			await act(async () => apply.click());
		},
	};
}

test("Apply inserts a link at the caret without submitting the compose form", async (t) => {
	const popup = await openLinkPopup(t);
	await popup.type(" example.com/docs ");
	await popup.clickApply();
	assert.equal(popup.submits(), 0);
	assert.equal(popup.popupOpen(), false);
	assert.deepEqual(popup.commands, [
		{ command: "insertHTML", value: '<a href="https://example.com/docs">https://example.com/docs</a>', selection: "" },
	]);
});

test("Enter inserts the link and neither submits nor reaches the compose form", async (t) => {
	const popup = await openLinkPopup(t);
	await popup.type("https://example.com/read");
	const event = await popup.press("Enter");
	assert.equal(event.defaultPrevented, true, "the browser's implicit form submission is prevented");
	assert.equal(popup.formKeys(), 0, "the composer's key handler never sees Enter");
	assert.equal(popup.submits(), 0);
	assert.equal(popup.popupOpen(), false);
	assert.deepEqual(popup.commands, [
		{
			command: "insertHTML",
			value: '<a href="https://example.com/read">https://example.com/read</a>',
			selection: "",
		},
	]);
});

test("Apply with a blank address closes the popup without inserting anything", async (t) => {
	const popup = await openLinkPopup(t);
	await popup.type("   ");
	await popup.clickApply();
	assert.equal(popup.submits(), 0);
	assert.equal(popup.popupOpen(), false);
	assert.deepEqual(popup.commands, []);
});

test("Escape closes the popup without reaching the composer", async (t) => {
	const popup = await openLinkPopup(t);
	await popup.type("https://example.com");
	const event = await popup.press("Escape");
	assert.equal(event.defaultPrevented, true);
	assert.equal(popup.formKeys(), 0, "Escape does not also leave the composer's modal mode");
	assert.equal(popup.popupOpen(), false);
	assert.deepEqual(popup.commands, []);
});

test("Escape on Apply closes the popup without reaching the composer", async (t) => {
	const popup = await openLinkPopup(t);
	await popup.type("https://example.com");
	const event = await popup.press("Escape", { apply: true });
	assert.equal(event.defaultPrevented, true);
	assert.equal(popup.formKeys(), 0);
	assert.equal(popup.popupOpen(), false);
	assert.deepEqual(popup.commands, []);
});

for (const key of ["Enter", "Escape"]) {
	test(`${key} during IME composition is left to the input method and does not reach the composer`, async (t) => {
		const popup = await openLinkPopup(t);
		await popup.type("https://example.com/日本");
		const event = await popup.press(key, { isComposing: true });
		assert.equal(event.defaultPrevented, false, "the input method still receives the key");
		assert.equal(popup.formKeys(), 0, "the composer neither submits nor leaves its modal mode");
		assert.equal(popup.submits(), 0);
		assert.equal(popup.popupOpen(), true);
		assert.deepEqual(popup.commands, []);
	});
}

test("Enter on Apply keeps the button's native activation without inserting a second link", async (t) => {
	const popup = await openLinkPopup(t);
	await popup.type("https://example.com");
	const event = await popup.press("Enter", { apply: true });
	assert.equal(event.defaultPrevented, false);
	assert.deepEqual(popup.commands, [], "keydown leaves insertion to the native button click");
	await popup.clickApply();
	assert.equal(popup.commands.length, 1);
	assert.equal(popup.submits(), 0);
});
