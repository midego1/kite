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
const ENGLISH = "Hello world";

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

test("a block-level signature is swapped, not duplicated, whatever direction each of its lines was given", () => {
	const signature = `<div>${ARABIC}</div><div>Sam</div><p>${HEBREW}</p>`;
	const fresh = h.applyMailboxSignatureHtml("", "", signature);
	const directions = ["", ' dir="auto"', ' dir="rtl"', ' dir="ltr"'];
	for (const first of directions) {
		for (const second of directions) {
			for (const third of directions) {
				const edited = `<div>Body</div>${fresh
					.replace(`<div>${ARABIC}</div>`, `<div${first}>${ARABIC}</div>`)
					.replace("<div>Sam</div>", `<div${second}>Sam</div>`)
					.replace(`<p>${HEBREW}</p>`, `<p${third}>${HEBREW}</p>`)
					.replace("<div><br></div>", "")}`;
				// The same signature again stays one; another one replaces it, with nothing of the old one left.
				const again = h.applyMailboxSignatureHtml(edited, signature, signature);
				assert.equal(again.match(/data-kite-signature/g)?.length, 1, again);
				assert.equal(again.match(/Sam/g)?.length, 1, again);
				const swapped = h.applyMailboxSignatureHtml(edited, signature, "Shared");
				assert.equal(swapped.match(/data-kite-signature/g)?.length, 1, swapped);
				assert.equal(swapped.includes("Sam"), false, swapped);
				assert.equal(swapped.includes(ARABIC), false, swapped);
				assert.equal(swapped.startsWith("<div>Body</div>"), true, swapped);
				assert.match(swapped, /Shared<\/div>$/);
				// Opening the draft again, with no previous signature known, finds it too.
				assert.equal(h.applyMailboxSignatureHtml(edited, "", signature), edited);
			}
		}
	}
});

test("the direction button on the block of a plain signature and on its lines still keeps one signature", () => {
	const signature = "Sam\nTreasurer";
	const fresh = h.applyMailboxSignatureHtml("<div>Body</div>", "", signature);
	for (const direction of ["auto", "rtl", "ltr"]) {
		const edited = fresh.replace('data-kite-signature="1"', `data-kite-signature="1" dir="${direction}"`);
		assert.equal(h.applyMailboxSignatureHtml(edited, "", signature), edited);
		const swapped = h.applyMailboxSignatureHtml(edited, signature, "New");
		assert.equal(swapped.match(/data-kite-signature/g)?.length, 1, swapped);
		assert.match(swapped, new RegExp(`data-kite-signature="1" dir="${direction}"`));
	}
});

test("switching to a mailbox with no signature removes a block-level signature whose lines were given a direction", () => {
	const signature = `<div>${ARABIC}</div><div>Sam</div>`;
	const fresh = h.applyMailboxSignatureHtml("<div>Body</div>", "", signature);
	for (const direction of ["rtl", "ltr", "auto"]) {
		const edited = fresh.replace("<div>Sam</div>", `<div dir="${direction}">Sam</div>`);
		for (const next of ["", null, undefined]) {
			const swapped = h.applyMailboxSignatureHtml(edited, signature, next);
			assert.equal(swapped, "<div>Body</div>", swapped);
		}
	}
	// With no signature before or after, nothing is added or removed.
	assert.equal(h.applyMailboxSignatureHtml("<div>Body</div>", "", ""), "<div>Body</div>");
});

test("direction in the middle of a tag's attributes, and signature text that looks like an attribute", () => {
	const signature = `<p lang="ar" title="Sig">${ARABIC}</p><p>Say dir="rtl" here</p>`;
	const fresh = h.applyMailboxSignatureHtml("<div>Body</div>", "", signature);
	for (const edited of [
		fresh.replace('lang="ar"', 'dir="rtl" lang="ar"'),
		fresh.replace('lang="ar"', 'lang="ar" dir="ltr"'),
		fresh.replace('title="Sig"', 'dir="rtl" title="Sig"'),
		fresh.replace('title="Sig"', 'title="Sig" dir="rtl"'),
	]) {
		assert.notEqual(edited, fresh);
		assert.equal(
			h.applyMailboxSignatureHtml(edited, signature, "Shared"),
			"<div>Body</div>" + h.applyMailboxSignatureHtml("", "", "Shared").replace("<div><br></div>", ""),
		);
		assert.equal(h.applyMailboxSignatureHtml(edited, "", signature), edited);
	}
});

test("the same signature in the other mailbox keeps the direction given to its lines", () => {
	const signature = `<div>${ARABIC}</div><div>Sam</div>`;
	const fresh = h.applyMailboxSignatureHtml("<div>Body</div>", "", signature);
	const edited = fresh.replace("<div>Sam</div>", '<div dir="rtl">Sam</div>');
	assert.equal(h.applyMailboxSignatureHtml(edited, signature, signature), edited);
});

test("a replacement signature is inserted as written, whatever characters it holds", () => {
	const fresh = h.applyMailboxSignatureHtml("<div>Body</div>", "", "Old");
	assert.match(h.applyMailboxSignatureHtml(fresh, "Old", "Cost $& $1 $$"), /Cost \$&amp; \$1 \$\$<\/div>$/);
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

test("many right-to-left paragraphs are handled in linear time", () => {
	// Doubling the input roughly doubles the time; a quadratic pass would quadruple it. A ratio holds on a slow runner.
	const time = (paragraphs) => {
		const html = `<div>${ARABIC}</div>`.repeat(paragraphs);
		const started = performance.now();
		const result = h.withAutoDirection(html);
		const elapsed = performance.now() - started;
		assert.equal(result.split('dir="auto"').length - 1, paragraphs);
		return elapsed;
	};
	time(500);
	const small = Math.min(time(2000), time(2000));
	const large = Math.min(time(8000), time(8000));
	assert.ok(large < small * 8, `${large}ms for 8000 paragraphs against ${small}ms for 2000`);
});

test("what is sent has auto resolved to rtl or ltr, and the draft keeps auto", () => {
	const draft = `<div dir="auto">${ARABIC}</div><div dir="auto">${ENGLISH}</div><div dir="auto">12 :)</div><div>plain</div>`;
	assert.equal(
		h.resolveAutoDirections(draft),
		`<div dir="rtl">${ARABIC}</div><div dir="ltr">${ENGLISH}</div><div>12 :)</div><div>plain</div>`,
	);
	// An element's auto ignores a descendant that has a dir of its own.
	assert.equal(
		h.resolveAutoDirections(`<div dir="auto"><div dir="rtl">${ARABIC}</div>${ENGLISH}</div>`),
		`<div dir="ltr"><div dir="rtl">${ARABIC}</div>${ENGLISH}</div>`,
	);
	assert.equal(
		h.resolveAutoDirections(`<blockquote dir="auto"><div>${HEBREW}</div></blockquote>`),
		`<blockquote dir="rtl"><div>${HEBREW}</div></blockquote>`,
	);
	// Explicit directions stay; with no auto the very same string comes back.
	for (const html of [`<div dir="ltr">${ARABIC}</div>`, "<div>Hello</div>", "", `<div dir="rtl">${ARABIC}</div>`]) {
		assert.equal(h.resolveAutoDirections(html), html);
	}
	// The text part is built from the resolved HTML and reads the same.
	const resolved = h.resolveAutoDirections(draft);
	assert.equal(h.htmlToPlainText(resolved), h.htmlToPlainText(draft));
	// Through the quote too: the original's paragraphs are resolved with the rest.
	const full = h.joinQuotedHtml(`<div>${ENGLISH}</div>`, `<div>${ARABIC}</div>`);
	assert.match(h.resolveAutoDirections(full), new RegExp(`<div dir="rtl">${ARABIC}</div>`));
});

test("a quoted original keeps the direction its sender gave it", () => {
	const original = `<div dir="rtl"><div>English line</div><div>${ARABIC}</div></div>`;
	assert.equal(
		h.wrapQuotedHtml(original),
		`<div class="kite-quote" data-kite-quote="1"><div dir="rtl"><div>English line</div><div dir="auto">${ARABIC}</div></div></div>`,
	);
	// Lists and blocks that hold other blocks are left as written, and so is left-to-right mail.
	const list = `<ul><li>${ARABIC}</li><li>English</li></ul>`;
	assert.equal(
		h.wrapQuotedHtml(list),
		`<div class="kite-quote" data-kite-quote="1"><ul><li dir="auto">${ARABIC}</li><li>English</li></ul></div>`,
	);
	const nested = `<div>${ARABIC}<div>English</div></div>`;
	assert.equal(h.wrapQuotedHtml(nested), `<div class="kite-quote" data-kite-quote="1">${nested}</div>`);
	const english = `<div dir="ltr"><div>Hello</div></div>`;
	assert.equal(h.wrapQuotedHtml(english), `<div class="kite-quote" data-kite-quote="1">${english}</div>`);
});

test("a list follows its first item, and goes back when the Arabic is replaced", () => {
	const editor = element(`<ul><li>${ARABIC}</li><li>English item</li></ul>`);
	h.applyAutoDirection(editor);
	assert.equal(editor.querySelector("ul").getAttribute("dir"), "rtl");
	// The Arabic is replaced by English: the list reads left to right again and drops its dir.
	editor.querySelector("li").textContent = "Now English";
	editor.querySelector("li").removeAttribute("dir");
	h.applyAutoDirection(editor);
	assert.equal(editor.querySelector("ul").hasAttribute("dir"), false);
	// Switching the first item's direction with the button moves the list with it.
	h.setParagraphDirection(editor.querySelector("li"), "rtl");
	h.applyAutoDirection(editor);
	assert.equal(editor.querySelector("ul").getAttribute("dir"), "rtl");
	h.setParagraphDirection(editor.querySelector("li"), "ltr");
	h.applyAutoDirection(editor);
	assert.equal(editor.querySelector("ul").getAttribute("dir"), "ltr");
});

test("an HTML signature with an inner block is found again whichever direction the editor gave it", () => {
	const signature = `${ARABIC}<div>Sam</div>`;
	const fresh = h.applyMailboxSignatureHtml("", "", signature);
	const editor = element(fresh);
	h.applyAutoDirection(editor);
	// The editor put a dir on the block and on the English line inside it; the swap has to recognise that.
	assert.match(editor.innerHTML, /data-kite-signature="1" dir="auto"/);
	const swapped = h.applyMailboxSignatureHtml(editor.innerHTML, signature, "Alex");
	assert.equal(swapped.includes(ARABIC), false);
	assert.equal(swapped.match(/data-kite-signature/g).length, 1);
	// The same signature again changes nothing, and an English one in a block the button set to ltr is found too.
	assert.equal(h.applyMailboxSignatureHtml(editor.innerHTML, signature, signature), editor.innerHTML);
	const english = h.applyMailboxSignatureHtml("", "", "<p>Alex</p><div>Sam</div>");
	const flipped = element(english);
	h.setParagraphDirection(flipped.querySelector("[data-kite-signature]"), "ltr");
	h.applyAutoDirection(flipped);
	assert.equal(h.applyMailboxSignatureHtml(flipped.innerHTML, "<p>Alex</p><div>Sam</div>", "").includes("Alex"), false);
});

test("the direction button reaches the loose first line, and not the block a triple-click ends in", () => {
	document.body.replaceChildren();
	const editor = element(`Hello<div>World</div><div>Third</div>`);
	document.body.appendChild(editor);
	const range = document.createRange();
	range.selectNodeContents(editor);
	assert.equal(h.hasLooseContentInRange(editor, range), true);
	assert.deepEqual(
		h.paragraphsInRange(editor, range).map((node) => node.textContent),
		["World", "Third"],
	);
	// A caret in the loose line is "loose content"; in a block it is not.
	const caret = document.createRange();
	caret.setStart(editor.firstChild, 2);
	assert.equal(h.hasLooseContentInRange(editor, caret), true);
	caret.setStart(editor.querySelector("div").firstChild, 2);
	caret.collapse(true);
	assert.equal(h.hasLooseContentInRange(editor, caret), false);
	assert.deepEqual(
		h.paragraphsInRange(editor, caret).map((node) => node.textContent),
		["World"],
	);
	// Triple-click on "World": the selection ends at offset 0 of the next block, which must not flip.
	const triple = document.createRange();
	triple.setStart(editor.querySelector("div").firstChild, 0);
	triple.setEnd(editor.querySelectorAll("div")[1], 0);
	assert.deepEqual(
		h.paragraphsInRange(editor, triple).map((node) => node.textContent),
		["World"],
	);
	const tripleInText = document.createRange();
	tripleInText.setStart(editor.querySelector("div").firstChild, 0);
	tripleInText.setEnd(editor.querySelectorAll("div")[1].firstChild, 0);
	assert.deepEqual(
		h.paragraphsInRange(editor, tripleInText).map((node) => node.textContent),
		["World"],
	);
	// A selection that really enters the next block still counts it, and a caret at offset 0 selects its own block.
	const into = document.createRange();
	into.setStart(editor.querySelector("div").firstChild, 0);
	into.setEnd(editor.querySelectorAll("div")[1].firstChild, 2);
	assert.equal(h.paragraphsInRange(editor, into).length, 2);
	const atStart = document.createRange();
	atStart.setStart(editor.querySelectorAll("div")[1].firstChild, 0);
	atStart.collapse(true);
	assert.deepEqual(
		h.paragraphsInRange(editor, atStart).map((node) => node.textContent),
		["Third"],
	);
});

test("an assistant's draft text carries its directions without the composer", () => {
	assert.equal(h.textToDirectedHtml("Hello\nWorld"), h.textToHtml("Hello\nWorld"));
	assert.equal(h.textToDirectedHtml(""), "");
	assert.equal(
		h.textToDirectedHtml(`${ARABIC}\n\nHello <b>\n${HEBREW}`),
		`<div dir="rtl">${ARABIC}</div><div><br></div><div dir="ltr">Hello &lt;b&gt;</div><div dir="rtl">${HEBREW}</div>`,
	);
});

test("block-level right-to-left signatures are found again as the editor holds them", () => {
	for (const signature of [
		`<div>${ARABIC}</div><div>Sam</div>`,
		`<p>${ARABIC}</p>`,
		`<ul><li>${ARABIC}</li><li>Sam</li></ul>`,
		`<p>${ARABIC}</p><ul><li>${HEBREW}</li></ul>`,
	]) {
		const fresh = h.applyMailboxSignatureHtml("<div>Body</div>", "", signature);
		// What the editor holds after its own pass, and what a draft saved from it holds.
		const editor = element(fresh);
		h.applyAutoDirection(editor);
		for (const held of [fresh, editor.innerHTML, h.joinQuotedHtml(editor.innerHTML, null)]) {
			const swapped = h.applyMailboxSignatureHtml(held, signature, "Alex");
			assert.equal(swapped.match(/data-kite-signature/g).length, 1, signature);
			assert.equal(swapped.includes(ARABIC), false, signature);
			assert.equal(h.applyMailboxSignatureHtml(held, signature, signature).match(/data-kite-signature/g).length, 1);
		}
		// And switching back to it from a plain signature, then away again, never leaves two.
		const back = h.applyMailboxSignatureHtml(
			h.applyMailboxSignatureHtml(editor.innerHTML, signature, "Alex"),
			"Alex",
			signature,
		);
		assert.equal(back.match(/data-kite-signature/g).length, 1);
	}
});

test("loose text is found run by run, optionally only when it starts right to left", () => {
	assert.equal(h.findLooseRun(element("<div>One</div><div>Two</div>")), null);
	assert.equal(h.findLooseRun(element("  <div>One</div>\n<div>Two</div>")), null);
	const english = element(`Hello<div>${ARABIC}</div>`);
	assert.equal(h.findLooseRun(english), english.firstChild);
	assert.equal(h.findLooseRun(english, { onlyRtl: true }), null);
	const arabic = element(`${ARABIC}<br>more<div>x</div>`);
	assert.equal(h.findLooseRun(arabic, { onlyRtl: true }), arabic.firstChild);
	// A run after a block is found too, as a multi-line paste can leave one.
	const later = element(`<div>x</div><b>${ARABIC}</b>`);
	assert.equal(h.findLooseRun(later, { onlyRtl: true }), later.lastChild);
});
