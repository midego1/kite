import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-button-hydration-");
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `export { Button } from "./src/components/ui/button.tsx";`,
		resolveDir: root,
		sourcefile: "button-hydration-entry.ts",
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
const { Button } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

function withDom(t, html) {
	const dom = new JSDOM(`<div id='root'>${html}</div>`);
	const previousGlobals = new Map();
	for (const [key, value] of Object.entries({
		window: dom.window,
		document: dom.window.document,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	t.after(() => {
		dom.window.close();
		for (const [key, previous] of previousGlobals) {
			if (previous) Object.defineProperty(globalThis, key, previous);
			else delete globalThis[key];
		}
	});
	return dom.window.document.getElementById("root");
}

function form(onSubmit, onClick) {
	return createElement(
		"form",
		{ onSubmit },
		createElement(Button, { type: "submit", onClick }, "Sign in"),
		createElement(Button, { asChild: true }, createElement("a", { href: "/inbox" }, "Inbox")),
	);
}

test("the server renders a button disabled until it is hydrated, but not a link", () => {
	const html = renderToString(form(() => {}));
	assert.match(html, /<button[^>]*disabled=""[^>]*>Sign in<\/button>/);
	assert.match(html, /<button[^>]*data-hydrating=""/);
	assert.doesNotMatch(html, /<a[^>]*\sdisabled=/);
	// It keeps its look while it waits, rather than flashing dimmed.
	assert.match(html, /data-hydrating:disabled:opacity-100/);
});

test("hydration enables the button and its handler runs", async (t) => {
	const clicks = [];
	const element = form(
		(event) => {
			event.preventDefault();
			clicks.push("submit");
		},
		() => clicks.push("click"),
	);
	const container = withDom(t, renderToString(element));
	const button = container.querySelector("button");
	assert.equal(button.disabled, true);

	let hydrated;
	await act(async () => {
		hydrated = hydrateRoot(container, element);
	});
	// The same element, now interactive: nothing was replaced.
	assert.equal(container.querySelector("button"), button);
	assert.equal(button.disabled, false);
	assert.equal(button.hasAttribute("data-hydrating"), false);
	await act(async () => button.click());
	assert.deepEqual(clicks, ["click", "submit"]);
	// Unmounted here, while the DOM globals the test set up still exist.
	await act(() => hydrated.unmount());
});

test("a button mounted after hydration is enabled from its first render, and disabled still wins", async (t) => {
	const container = withDom(t, "");
	const mounted = createRoot(container);
	await act(async () => {
		mounted.render(
			createElement(
				"div",
				null,
				createElement(Button, null, "Save"),
				createElement(Button, { disabled: true }, "Busy"),
			),
		);
	});
	const [save, busy] = container.querySelectorAll("button");
	assert.equal(save.disabled, false);
	assert.equal(save.hasAttribute("data-hydrating"), false);
	assert.equal(busy.disabled, true);
	await act(() => mounted.unmount());
});
