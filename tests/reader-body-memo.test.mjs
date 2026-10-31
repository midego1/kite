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
const directory = makeBundleDirectory("kite-reader-body-memo-");
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { useReaderBody } from "./src/components/messages/use-reader-body.ts";
			export { inlineAttachmentKey, parseInlineAttachmentKey } from "./src/components/messages/reader-body-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "reader-body-memo-entry.ts",
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
const { useReaderBody, inlineAttachmentKey, parseInlineAttachmentKey } = await import(
	pathToFileURL(join(directory, "entry.mjs")).href
);

/** A newsletter-sized body: many rows, links, remote images and an inline image. */
const NEWSLETTER = `<table>${Array.from(
	{ length: 60 },
	(_, row) =>
		`<tr><td style="color:#222;background:#fff"><a href="https://shop.example/item/${row}">Item ${row}</a> ` +
		`<img src="https://cdn.example/${row}.png"> Visit www.example.test/${row}</td></tr>`,
).join("")}</table><img src="cid:logo@example">`;

/**
 * Mounts a component that reads the body through the hook and counts every HTML parse: the sanitizer and the quote
 * fold both parse through the window's DOMParser, so the count is the number of times the pipeline ran.
 */
async function mount(t) {
	const dom = new JSDOM("<div id='root'></div>", { url: "https://kite.test/inbox" });
	const parser = dom.window.DOMParser.prototype;
	const parse = parser.parseFromString;
	let parses = 0;
	parser.parseFromString = function (...args) {
		parses += 1;
		return parse.apply(this, args);
	};
	const previousGlobals = new Map();
	for (const [key, value] of Object.entries({
		window: dom.window,
		document: dom.window.document,
		DOMParser: dom.window.DOMParser,
		HTMLElement: dom.window.HTMLElement,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	let body;
	function Reader({ input }) {
		body = useReaderBody(input);
		return null;
	}
	const mounted = createRoot(dom.window.document.getElementById("root"));
	t.after(async () => {
		await act(() => mounted.unmount());
		dom.window.close();
		for (const [key, previous] of previousGlobals) {
			if (previous) Object.defineProperty(globalThis, key, previous);
			else delete globalThis[key];
		}
	});
	return {
		get body() {
			return body;
		},
		get parses() {
			return parses;
		},
		render: (input) => act(() => mounted.render(createElement(Reader, { input }))),
	};
}

/** A fresh input object with fresh attachment objects each time, as a parent re-render or a refetch makes. */
function readerInput(overrides = {}) {
	return {
		messageId: "message-1",
		textBody: null,
		htmlBody: NEWSLETTER,
		snippet: "Item 0",
		ownAddress: "me@example.test",
		attachments: [
			{ id: "att-logo", contentId: "<logo@example>", disposition: "inline", filename: "logo.png" },
			{ id: "att-pdf", contentId: null, disposition: "attachment", filename: "invoice.pdf" },
		],
		blockRemoteImages: true,
		dropFontFamily: false,
		...overrides,
	};
}

test("the reader sanitizes a message once across re-renders and again only when its input changes", async (t) => {
	const reader = await mount(t);
	await reader.render(readerInput());
	const first = reader.body;
	const parsesAfterFirstRender = reader.parses;
	assert.ok(parsesAfterFirstRender > 0, "the first render sanitizes the body");
	assert.match(first.html, /\/api\/messages\/message-1\/attachments\/att-logo/);
	assert.equal(first.blockedRemoteImages, 60);
	assert.doesNotMatch(first.html, /cdn\.example/);

	// Startup re-renders the reader many times (session, mailboxes, thread, summary, preferences).
	for (let index = 0; index < 20; index += 1) await reader.render(readerInput());
	assert.equal(reader.parses, parsesAfterFirstRender);
	assert.equal(reader.body, first);

	// Showing remote images is a different rendering, so it runs once more.
	await reader.render(readerInput({ blockRemoteImages: false }));
	assert.equal(reader.parses, parsesAfterFirstRender * 2);
	assert.equal(reader.body.blockedRemoteImages, 0);
	await reader.render(readerInput({ blockRemoteImages: false }));
	assert.equal(reader.parses, parsesAfterFirstRender * 2);

	// So does another message.
	await reader.render(readerInput({ messageId: "message-2", blockRemoteImages: false }));
	assert.equal(reader.parses, parsesAfterFirstRender * 3);
	assert.match(reader.body.html, /\/api\/messages\/message-2\/attachments\/att-logo/);
});

test("a collapsed card renders no body and never sanitizes", async (t) => {
	const reader = await mount(t);
	await reader.render(null);
	await reader.render(null);
	assert.equal(reader.body, null);
	assert.equal(reader.parses, 0);
});

test("the attachment key only follows inline attachments", () => {
	const key = inlineAttachmentKey(readerInput().attachments);
	assert.equal(inlineAttachmentKey(readerInput().attachments), key);
	assert.deepEqual(parseInlineAttachmentKey(key), [{ id: "att-logo", contentId: "<logo@example>" }]);
	assert.equal(inlineAttachmentKey([{ id: "att-pdf", contentId: null }]), "");
	assert.deepEqual(parseInlineAttachmentKey(""), []);
	assert.notEqual(inlineAttachmentKey([{ id: "att-other", contentId: "<logo@example>" }]), key);
});
