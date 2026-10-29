import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-linkify-test-");
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { findLinks, splitLinkedText } from "./src/lib/email/linkify-utils.ts";
			export { htmlToPlainText } from "./src/components/compose/rich-text-utils.ts";
			export { linkifyTextNodes } from "./src/lib/email/linkify-dom-utils.ts";
			export { createEmailHtmlSanitizer } from "./src/app/(dashboard)/inbox/[messageId]/email-html-sanitizer-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "linkify-test-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	absWorkingDir: root,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const { findLinks, splitLinkedText, linkifyTextNodes, createEmailHtmlSanitizer, htmlToPlainText } = await import(
	pathToFileURL(join(directory, "entry.mjs")).href
);

const { window } = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://kite.example/inbox" });
const sanitize = createEmailHtmlSanitizer(window);

function texts(text) {
	return findLinks(text).map((link) => link.text);
}

test("a plain address becomes a link to itself", () => {
	const [link] = findLinks("Take a look at https://github.com/midego1/kite today");
	assert.equal(link.text, "https://github.com/midego1/kite");
	assert.equal(link.href, "https://github.com/midego1/kite");
	assert.equal(link.kind, "url");
	assert.deepEqual(splitLinkedText("a https://x.example b"), [
		"a ",
		{ text: "https://x.example", href: "https://x.example" },
		" b",
	]);
});

test("www. addresses link over https and need a real host", () => {
	const [link] = findLinks("go to www.example.com/page now");
	assert.equal(link.text, "www.example.com/page");
	assert.equal(link.href, "https://www.example.com/page");
	assert.deepEqual(texts("www.com and www. alone"), []);
});

test("trailing punctuation belongs to the sentence", () => {
	assert.deepEqual(texts("see https://x.com/a)."), ["https://x.com/a"]);
	assert.deepEqual(texts("(see https://x.com/a)."), ["https://x.com/a"]);
	assert.deepEqual(texts("really? https://x.com/a?b=1, https://y.com!"), ["https://x.com/a?b=1", "https://y.com"]);
	assert.deepEqual(texts('"https://x.com/a"'), ["https://x.com/a"]);
	assert.deepEqual(texts("https://x.com/a;"), ["https://x.com/a"]);
	assert.deepEqual(texts("（https://x.com/a）。"), ["https://x.com/a"]);
});

test("balanced parentheses stay part of the address", () => {
	assert.deepEqual(texts("https://en.wikipedia.org/wiki/Kite_(bird)"), ["https://en.wikipedia.org/wiki/Kite_(bird)"]);
	assert.deepEqual(texts("(https://en.wikipedia.org/wiki/Kite_(bird))"), ["https://en.wikipedia.org/wiki/Kite_(bird)"]);
	assert.deepEqual(texts("[https://x.com/a]"), ["https://x.com/a"]);
});

test("international and long addresses link; absurdly long ones do not", () => {
	assert.deepEqual(texts("https://bücher.example/straße?q=café"), ["https://bücher.example/straße?q=café"]);
	assert.deepEqual(texts("https://例え.jp/パス"), ["https://例え.jp/パス"]);
	const long = `https://example.com/${"a".repeat(1500)}?x=${"b".repeat(100)}`;
	assert.deepEqual(texts(`see ${long} ok`), [long]);
	assert.deepEqual(texts(`https://example.com/${"a".repeat(3000)}`), []);
});

test("email addresses link as mailto", () => {
	const [link] = findLinks("Mail first.last+tag@sub.example.co.uk, please.");
	assert.equal(link.text, "first.last+tag@sub.example.co.uk");
	assert.equal(link.href, "mailto:first.last+tag@sub.example.co.uk");
	assert.equal(link.kind, "email");
	assert.deepEqual(texts("not an email: foo@bar, @handle, a@b.c"), []);
	assert.deepEqual(texts("<jan@example.com>"), ["jan@example.com"]);
});

test("an email inside an address does not become a second link", () => {
	assert.deepEqual(texts("https://x.example/?to=jan@example.com"), ["https://x.example/?to=jan@example.com"]);
});

test("only http, https and mailto links are ever made", () => {
	for (const text of [
		"javascript:alert(1)",
		"JaVaScRiPt:alert(document.cookie)//https://",
		"data:text/html,<script>alert(1)</script>",
		"vbscript:msgbox(1)",
		"file:///etc/passwd",
		"ftp://example.com/x",
	]) {
		for (const link of findLinks(text)) assert.match(link.href, /^(?:https?:\/\/|mailto:)/i, text);
	}
	assert.deepEqual(texts("javascript:alert(1) data:text/html;base64,AAAA"), []);
	assert.deepEqual(texts("xhttps://example.com"), []);
});

test("an address with credentials is not linked, since it hides the real host", () => {
	assert.deepEqual(texts("https://paypal.com@evil.example/login"), []);
});

test("control and invisible characters end an address", () => {
	assert.deepEqual(texts("https://example.com/a‮bc"), ["https://example.com/a"]);
	assert.deepEqual(texts("https://example.com/a​b"), ["https://example.com/a"]);
});

test("text without addresses is returned whole", () => {
	assert.deepEqual(splitLinkedText("nothing to see: 3.14 and a.b"), ["nothing to see: 3.14 and a.b"]);
	assert.deepEqual(splitLinkedText(""), []);
});

function bodyOf(html) {
	const body = window.document.createElement("div");
	body.innerHTML = html;
	return body;
}

test("DOM linkifying leaves existing links and code alone", () => {
	const body = bodyOf(
		'<p>x https://a.example</p><p><a href="https://b.example">https://b.example</a></p><code>https://c.example</code><pre><code>https://d.example</code></pre>',
	);
	assert.equal(linkifyTextNodes(body), 1);
	assert.equal(
		body.innerHTML,
		'<p>x <a href="https://a.example">https://a.example</a></p><p><a href="https://b.example">https://b.example</a></p><code>https://c.example</code><pre><code>https://d.example</code></pre>',
	);
});

test("DOM linkifying escapes the text around a link", () => {
	const body = bodyOf("<p>1 &lt; 2 &amp; www.example.com/a?x=1&amp;y=2 &lt;b&gt;</p>");
	linkifyTextNodes(body);
	assert.equal(
		body.innerHTML,
		'<p>1 &lt; 2 &amp; <a href="https://www.example.com/a?x=1&amp;y=2">www.example.com/a?x=1&amp;y=2</a> &lt;b&gt;</p>',
	);
});

test("the reader sanitizer links addresses safely and only when asked", () => {
	const html = "<p>Repo: https://github.com/midego1/kite, mail me@example.com</p>";
	assert.equal(sanitize(html), html);
	const linked = sanitize(html, { linkify: true });
	const body = bodyOf(linked);
	const anchors = [...body.querySelectorAll("a")];
	assert.deepEqual(
		anchors.map((anchor) => anchor.getAttribute("href")),
		["https://github.com/midego1/kite", "mailto:me@example.com"],
	);
	for (const anchor of anchors) {
		assert.equal(anchor.getAttribute("target"), "_blank");
		assert.equal(anchor.getAttribute("rel"), "noopener noreferrer nofollow");
	}
	assert.equal(body.textContent, "Repo: https://github.com/midego1/kite, mail me@example.com");
	assert.equal(sanitize(html, { linkify: true, forOutgoing: true }), html);
});

test("the reader sanitizer does not link what a hostile message only looks like", () => {
	const linked = sanitize(
		'<p>javascript:alert(1)</p><a href="javascript:alert(2)">https://x.example</a><p>&lt;script&gt;https://y.example&lt;/script&gt;</p>',
		{ linkify: true },
	);
	const hrefs = [...bodyOf(linked).querySelectorAll("a[href]")].map((anchor) => anchor.getAttribute("href"));
	assert.deepEqual(hrefs, ["https://y.example"]);
	assert.doesNotMatch(linked, /javascript:alert\(1\)<\/a>/);
});

test("hostile 200k-character inputs are scanned in linear time", () => {
	const size = 200_000;
	const inputs = {
		closing: `http://a.com/${")".repeat(size)}`,
		closingAfterText: `see http://a.com/x${"]".repeat(size)} end`,
		opening: `http://a.com/${"(".repeat(size)}`,
		dots: `http://a.com/${".".repeat(size)}`,
		bareDots: ".".repeat(size),
		wordDots: "a.".repeat(size / 2),
		ats: "@".repeat(size),
		atsAndLetters: "a@".repeat(size / 2),
		emailLabels: `a@${"b.".repeat(size / 2)}`,
		emailDashes: `a@b.c${"-".repeat(size)}x`,
		longLocal: `${"a".repeat(size)}@`,
		schemes: "http://".repeat(size / 7),
		www: "www.".repeat(size / 4),
		colons: ":".repeat(size),
		mixed: "(http://a.com/x).,;!?)(".repeat(size / 22),
		spaced: "https://a.example/x) ".repeat(size / 21),
	};
	for (const [name, input] of Object.entries(inputs)) {
		findLinks(input);
		let fastest = Infinity;
		for (let run = 0; run < 3; run += 1) {
			const started = performance.now();
			findLinks(input);
			fastest = Math.min(fastest, performance.now() - started);
		}
		assert.ok(fastest < 250, `${name} took ${fastest.toFixed(1)} ms`);
	}
});

test("addresses over the length limit are rejected before they are trimmed", () => {
	assert.deepEqual(texts(`http://a.com/${")".repeat(5000)}`), []);
	assert.deepEqual(texts(`${"a".repeat(3000)}@example.com`), []);
});

test("the plain-text part keeps a typed address plain, with no (href) copy after it", () => {
	window.document.body.innerHTML = "";
	globalThis.DOMParser = window.DOMParser;
	globalThis.Node = window.Node;
	try {
		const html =
			'<div>see <a href="https://www.example.com">www.example.com</a> and <a href="https://example.org/a">https://example.org/a</a> or <a href="mailto:a@b.co">a@b.co</a></div>';
		assert.equal(htmlToPlainText(html), "see www.example.com and https://example.org/a or a@b.co");
		// The scheme and host ignore case; the path, query and fragment do not.
		assert.equal(
			htmlToPlainText('<div><a href="HTTPS://WWW.Example.com/Path?q=1#f">https://www.example.com/Path?q=1#f</a></div>'),
			"https://www.example.com/Path?q=1#f",
		);
		for (const [text, href] of [
			["https://x.com/abc", "https://x.com/AbC"],
			["https://x.com/a?q=x", "https://x.com/a?q=X"],
			["https://x.com/a#top", "https://x.com/a#Top"],
		]) {
			assert.equal(htmlToPlainText(`<div><a href="${href}">${text}</a></div>`), `${text} (${href})`);
		}
		// A link whose text says something else still shows where it goes.
		assert.equal(
			htmlToPlainText('<div><a href="https://example.org/a">my page</a></div>'),
			"my page (https://example.org/a)",
		);
	} finally {
		delete globalThis.DOMParser;
		delete globalThis.Node;
	}
});

test("trailing punctuation before the space is not part of a link", () => {
	assert.deepEqual(texts("go to https://x.com. Then"), ["https://x.com"]);
	assert.deepEqual(texts("(www.example.com),"), ["www.example.com"]);
});
