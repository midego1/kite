import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-rich-text-direction-");
after(() => rmSync(outDir, { recursive: true, force: true }));

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://mail.example.com/" });
for (const key of ["window", "document", "DOMParser", "Node", "Element", "HTMLElement", "Range"]) {
	globalThis[key] = key === "window" ? dom.window : dom.window[key];
}

await build({
	stdin: {
		contents: `
			export * from "./src/components/compose/rich-text-direction-utils.ts";
			export * from "./src/components/compose/rich-text-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "rich-text-direction-entry.ts",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	packages: "external",
	alias: { "@": join(root, "src") },
	logLevel: "silent",
});
const h = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

const ARABIC = "مرحبا بالعالم";
const HEBREW = "שלום עולם";

function element(html) {
	const host = document.createElement("div");
	host.innerHTML = html;
	return host;
}

test("the first strong letter decides, as dir=auto does", () => {
	assert.equal(h.firstStrongDirection(ARABIC), "rtl");
	assert.equal(h.firstStrongDirection(HEBREW), "rtl");
	assert.equal(h.firstStrongDirection("Hello"), "ltr");
	assert.equal(h.firstStrongDirection("123 - مرحبا"), "rtl");
	assert.equal(h.firstStrongDirection("Hello مرحبا"), "ltr");
	assert.equal(h.firstStrongDirection("‏abc"), "rtl");
	assert.equal(h.firstStrongDirection("12 :) !"), null);
	// Arabic-Indic digits are numbers, not letters.
	assert.equal(h.firstStrongDirection("٣٤٥"), null);
	assert.equal(h.firstStrongDirection(""), null);
});

test("left-to-right HTML comes back as the very same string", () => {
	for (const html of [
		"",
		"<div>Hello</div><div>World</div>",
		"Loose text<br>and more",
		'<ul><li>One</li></ul><div class="kite-quote" data-kite-quote="1"><p>Quoted</p></div>',
		"<div>café über 你好</div>",
		"<div>1 + 1 = 2</div>",
	]) {
		assert.equal(h.withAutoDirection(html), html);
		assert.equal(h.joinQuotedHtml(html, null), html);
	}
});

test("a right-to-left paragraph gets dir=auto and an English one next to it does not", () => {
	assert.equal(
		h.withAutoDirection(`<div>Hello</div><div>${ARABIC}</div><div>${HEBREW}</div>`),
		`<div>Hello</div><div dir="auto">${ARABIC}</div><div dir="auto">${HEBREW}</div>`,
	);
	assert.equal(h.withAutoDirection(`<p>${ARABIC} and English</p>`), `<p dir="auto">${ARABIC} and English</p>`);
});

test("a first line typed into an empty editor is wrapped so it can carry a direction", () => {
	assert.equal(h.withAutoDirection(ARABIC), `<div dir="auto">${ARABIC}</div>`);
	assert.equal(
		h.withAutoDirection(`${ARABIC}<br><div>second</div>`),
		`<div dir="auto">${ARABIC}<br></div><div>second</div>`,
	);
	// A loose English line stays loose, and loose text is left alone when asked.
	assert.equal(h.withAutoDirection("Hello<br>" + ARABIC), "Hello<br>" + ARABIC);
	assert.equal(h.withAutoDirection(ARABIC, { wrapLooseText: false }), ARABIC);
});

test("directions already there are kept, and running twice changes nothing more", () => {
	const html = `<div dir="ltr">${ARABIC}</div><div dir="rtl">Hello</div><div dir="auto">${HEBREW}</div>`;
	assert.equal(h.withAutoDirection(html), html);
	const once = h.withAutoDirection(`<div>${ARABIC}</div>`);
	assert.equal(h.withAutoDirection(once), once);
});

test("an English item inside an Arabic list keeps its own direction", () => {
	assert.equal(
		h.withAutoDirection(`<ul><li>${ARABIC}</li><li>English item</li></ul>`),
		`<ul dir="rtl"><li dir="auto">${ARABIC}</li><li dir="auto">English item</li></ul>`,
	);
	assert.equal(h.withAutoDirection("<ul><li>One</li><li>Two</li></ul>"), "<ul><li>One</li><li>Two</li></ul>");
});

test("a container holding blocks is not given a direction of its own", () => {
	assert.equal(
		h.withAutoDirection(`<blockquote><div>${ARABIC}</div><div>English</div></blockquote>`),
		`<blockquote><div dir="auto">${ARABIC}</div><div>English</div></blockquote>`,
	);
});

test("applyAutoDirection edits in place and counts the paragraphs it changed", () => {
	const editor = element(`<div>${ARABIC}</div><div>Hello</div><div dir="rtl">${HEBREW}</div>`);
	assert.equal(h.applyAutoDirection(editor), 1);
	assert.equal(h.applyAutoDirection(editor), 0);
	assert.equal(editor.innerHTML, `<div dir="auto">${ARABIC}</div><div>Hello</div><div dir="rtl">${HEBREW}</div>`);
	assert.equal(h.applyAutoDirection(element("<div>Hello</div>")), 0);
});

test("a quote keeps the direction of the original, whatever the reply is written in", () => {
	const arabicOriginal = h.wrapQuotedHtml(
		`<div style="margin-top:1.4em">On Mon, ada wrote:</div><blockquote><div>${ARABIC}</div></blockquote>`,
	);
	assert.match(arabicOriginal, /^<div class="kite-quote" data-kite-quote="1">/);
	assert.match(arabicOriginal, new RegExp(`<div dir="auto">${ARABIC}</div>`));
	assert.doesNotMatch(arabicOriginal, /margin-top:1.4em" dir/);
	const englishOriginal = h.wrapQuotedHtml("<blockquote><div>Hello</div></blockquote>");
	assert.equal(
		englishOriginal,
		'<div class="kite-quote" data-kite-quote="1"><blockquote><div>Hello</div></blockquote></div>',
	);

	const draft = h.joinQuotedHtml(`<div>${ARABIC}</div>`, "<div>English original</div>");
	const parts = h.splitQuotedHtml(draft);
	assert.equal(parts.body, `<div dir="auto">${ARABIC}</div>`);
	assert.equal(parts.quoted, "<div>English original</div>");
	// Splitting the saved draft again and joining it gives the same draft.
	assert.equal(h.joinQuotedHtml(parts.body, parts.quoted), draft);
});

test("a stored draft with directions loads unchanged", () => {
	const html = `<div dir="auto">${ARABIC}</div><div dir="rtl">${HEBREW}</div>`;
	const loaded = h.splitStoredDraftHtml(html, "");
	assert.equal(loaded.body, html);
	assert.equal(loaded.quoted, null);
});

test("an Arabic signature is swapped, not duplicated, whichever direction the editor gave it", () => {
	const fresh = h.applyMailboxSignatureHtml("", "", ARABIC);
	assert.equal(fresh, `<div><br></div><div data-kite-signature="1"><br><br>${ARABIC}</div>`);
	for (const direction of ["", ' dir="auto"', ' dir="rtl"', ' dir="ltr"']) {
		const edited = fresh.replace('data-kite-signature="1"', `data-kite-signature="1"${direction}`);
		assert.equal(
			h.applyMailboxSignatureHtml(edited, ARABIC, "Sam"),
			`<div><br></div><div data-kite-signature="1"${direction}><br><br>Sam</div>`,
		);
		assert.equal(h.applyMailboxSignatureHtml(edited, ARABIC, ARABIC), edited);
	}
	// The editor's own pass puts dir=auto on the block; that is the form the swap has to find.
	const editor = element(fresh);
	h.applyAutoDirection(editor);
	assert.match(editor.innerHTML, /data-kite-signature="1" dir="auto"/);
	assert.equal(h.applyMailboxSignatureHtml(editor.innerHTML, ARABIC, "Sam").includes(ARABIC), false);
});

test("plain text stays logical: the same characters in the same order, with no direction marks", () => {
	// The text is what it is without the attribute; dir only changes how it is drawn.
	for (const html of [
		`<div>${ARABIC}</div><div>Hello</div>`,
		`<div>${HEBREW}<br>${ARABIC}</div>`,
		`<ul><li>${ARABIC}</li><li>two</li></ul>`,
		`<blockquote><div>${ARABIC}</div></blockquote>`,
	]) {
		const plain = h.htmlToPlainText(html);
		assert.equal(h.htmlToPlainText(h.withAutoDirection(html)), plain);
		assert.equal(h.htmlToPlainText(h.withAutoDirection(html)).includes("\u200F"), false);
	}
	assert.equal(h.htmlToPlainText(`<div dir="rtl">${HEBREW}<br>${ARABIC}</div>`), `${HEBREW}\n${ARABIC}`);
	assert.equal(
		h.htmlToPlainText(`<ul dir="rtl"><li dir="auto">${ARABIC}</li><li dir="auto">two</li></ul>`),
		`- ${ARABIC}\n- two`,
	);
	assert.equal(h.htmlToPlainText(`<blockquote dir="auto"><div dir="auto">${ARABIC}</div></blockquote>`), `> ${ARABIC}`);
	// Unchanged for left-to-right text, with or without the attribute.
	assert.equal(h.htmlToPlainText('<div dir="ltr">Hello</div>'), h.htmlToPlainText("<div>Hello</div>"));
	assert.equal(h.htmlToPlainText("<div>Hello</div><div>World</div>"), "Hello\n\nWorld");
	const framed = h.joinQuotedHtml(`<div>${ARABIC}</div>`, `<div>${HEBREW}</div>`);
	assert.equal(h.htmlToPlainText(framed), `${ARABIC}\n\n${HEBREW}`);
});

test("the direction button cycles automatic, right to left, left to right", () => {
	assert.deepEqual(
		["auto", "rtl", "ltr"].map((value) => h.nextParagraphDirection(value)),
		["rtl", "ltr", "auto"],
	);
	const editor = element(`<div>${ARABIC}</div><div>Hello</div>`);
	const [arabic, english] = editor.children;
	assert.equal(h.paragraphDirection(arabic), "auto");
	h.setParagraphDirection(arabic, "rtl");
	assert.equal(arabic.getAttribute("dir"), "rtl");
	h.setParagraphDirection(arabic, "ltr");
	assert.equal(h.paragraphDirection(arabic), "ltr");
	h.setParagraphDirection(arabic, "auto");
	assert.equal(arabic.hasAttribute("dir"), false);
	// Automatic on an Arabic paragraph is what the editor's own pass puts back; an English one stays plain.
	h.applyAutoDirection(editor);
	assert.equal(arabic.getAttribute("dir"), "auto");
	assert.equal(h.paragraphDirection(english), "auto");
	assert.equal(english.hasAttribute("dir"), false);
});

test("the paragraphs a selection touches are found without the containers around them", () => {
	document.body.replaceChildren();
	const editor = element(`<div>one</div><blockquote><div>two</div><div>three</div></blockquote><ul><li>four</li></ul>`);
	document.body.appendChild(editor);
	const range = document.createRange();
	range.setStart(editor.querySelectorAll("div")[0].firstChild, 1);
	range.setEnd(editor.querySelectorAll("div")[1].firstChild, 1);
	assert.deepEqual(
		h.paragraphsInRange(editor, range).map((node) => node.textContent),
		["one", "two"],
	);
	range.selectNodeContents(editor.querySelector("li"));
	assert.deepEqual(
		h.paragraphsInRange(editor, range).map((node) => node.tagName),
		["LI"],
	);
});

test("a long run of right-to-left text is handled in linear time", () => {
	const html = `<div>${ARABIC.repeat(20_000)}</div>`.repeat(20);
	const started = performance.now();
	h.withAutoDirection(html);
	assert.ok(performance.now() - started < 1500);
});
