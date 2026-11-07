import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { XSS_PAYLOADS, findActiveContent } from "./fixtures/xss-payloads.mjs";

// The sanitizer runs on every parsed message. The large cases run in a child process with a 128 MB heap, so a bound
// that stops working shows up as a failed child instead of slowing the whole test run.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-stored-html-bounds-");
after(() => rmSync(directory, { recursive: true, force: true }));

const entry = join(directory, "entry.ts");
writeFileSync(
	entry,
	`
export { buildSnippet, parseRawMime } from "${root}/src/lib/email/parse";
export { sanitizeStoredEmailHtml } from "${root}/src/lib/email/stored-html-utils";
`,
);
const bundle = join(directory, "entry.mjs");
await build({
	entryPoints: [entry],
	outfile: bundle,
	bundle: true,
	absWorkingDir: root,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const { sanitizeStoredEmailHtml } = await import(pathToFileURL(bundle).href);
const MAX_OPEN_ELEMENTS = 512;
const MAX_TAG_ATTRIBUTES = 1_024;
const MAX_TAG_ENTITIES = 256 * 1024;
const MAX_SANITIZED_HTML_CHARS = 8_000_000;

const worker = join(directory, "worker.mjs");
writeFileSync(
	worker,
	`
import { buildSnippet, parseRawMime } from ${JSON.stringify(pathToFileURL(bundle).href)};

const header = "From: a@example.com\\r\\nTo: b@example.com\\r\\nSubject: x\\r\\nMIME-Version: 1.0\\r\\nContent-Type: text/html\\r\\n\\r\\n";
const lines = (line, count) => (line + "\\r\\n").repeat(count);
const tagWith = (names, quotes) => "<p " + names.map((name) => name + "='" + '"'.repeat(quotes) + "'").join(" ") + ">x";
const shapes = {
	openShort: () => lines("<b>", 149_000),
	openLong: () => lines("<b>".repeat(18), 149_000),
	openLarge: () => lines("<b>".repeat(198), 39_000),
	openAttributes: () => lines("<a x=1>".repeat(22), 149_000),
	openDivs: () => lines("<div>".repeat(130), 39_000),
	closedDivs: () => lines("<div></div>".repeat(50), 7_000),
	longDivs: () => lines("<div>" + "x".repeat(150) + "</div>", 25_000),
	largeDivs: () => lines("<div>" + "x".repeat(150) + "</div>", 149_000),
	paragraphs: () => lines("<p>".repeat(100), 75_000),
	listItems: () => lines("<li>".repeat(100), 56_000),
	breaks: () => lines("<br>".repeat(38), 149_000),
	ampersands: () => lines("&".repeat(150), 149_000),
	entities: () => lines("&lt;".repeat(38), 149_000),
	unmatchedCloses: () => "<b>".repeat(500) + lines("</i>".repeat(38), 149_000),
	insideOpen: () => "<b>".repeat(500) + lines("<i></i>".repeat(22), 149_000),
	roots: () => "x" + lines("<html>".repeat(26), 149_000),
	distinctAttributes: () => "<a " + Array.from({ length: 2_000_000 }, (_, index) => "a" + index.toString(36) + "=1").join(" ") + ">x",
	attributeEntities: () => '<a title="' + "&".repeat(23_000_000) + '">x',
	attributeQuotes: () => "<a title='" + '"'.repeat(23_000_000) + "'>x",
	urlSpaces: () => '<a href="' + " ".repeat(23_000_000) + 'x">x',
	sixAttributes: () => tagWith(["title", "class", "lang", "style", "dir", "width"], 3_000_000),
	smallerSixAttributes: () => tagWith(["title", "class", "lang", "style", "dir", "width"], 2_000_000),
	twoAttributes: () => tagWith(["title", "class"], 4_000_000),
	dataAttributes: () => tagWith(Array.from({ length: 1_000 }, (_, index) => "data-a" + index), 24_000),
	attributeReferences: () => '<a title="' + "&lt;".repeat(4_000_000) + '">x</a>',
	shortAttributeReferences: () => '<a title="' + "&lt".repeat(7_000_000) + '">x</a>',
	unknownTagReferences: () => '<zz y="' + "&lt;".repeat(4_000_000) + '">x</zz>',
	largeImage: () => '<p>one</p><img src="data:image/png;base64,' + "A".repeat(4_000_000) + '"><p>two</p>',
};

const out = {};
for (const [name, body] of Object.entries(shapes)) {
	const started = performance.now();
	const parsed = await parseRawMime(new TextEncoder().encode(header + body()).buffer);
	const snippet = buildSnippet(parsed.text, parsed.html);
	out[name] = { html: parsed.html?.length ?? 0, snippet: snippet.length, ms: Math.round(performance.now() - started) };
}
console.log(JSON.stringify(out));
`,
);

// Without coverage collection, which every child would inherit and which would have to fit in the same heap.
const childEnv = Object.fromEntries(
	Object.entries(process.env).filter(([name]) => name !== "NODE_V8_COVERAGE" && name !== "NODE_TEST_CONTEXT"),
);

test("large bodies of tags, text and attributes are sanitized within a 128 MB heap", () => {
	const output = execFileSync(process.execPath, ["--max-old-space-size=128", worker], {
		encoding: "utf8",
		env: childEnv,
		timeout: 300_000,
	});
	const results = JSON.parse(output);
	assert.equal(Object.keys(results).length, 28);
	for (const [name, result] of Object.entries(results)) {
		assert.ok(result.ms < 60_000, `${name}: ${result.ms} ms`);
		assert.ok(result.html <= MAX_SANITIZED_HTML_CHARS + 2_000_000, `${name}: ${result.html} characters`);
	}
	for (const name of ["sixAttributes", "smallerSixAttributes", "twoAttributes", "dataAttributes"]) {
		assert.ok(results[name].html <= MAX_SANITIZED_HTML_CHARS, `${name}: ${results[name].html} characters`);
	}
	// A large value without entities is an ordinary inline image.
	assert.equal(results.largeImage.html, 4_000_055);
	// Balanced markup up to the decoded HTML limit stays whole; past it, the whole lines that fit and the note.
	assert.equal(results.closedDivs.html, 7_000 * 551);
	assert.equal(results.longDivs.html, 25_000 * 162);
	assert.equal(results.largeDivs.html, Math.floor((4 * 1024 * 1024) / 163) * 162 + "<hr><p></p>".length + 110);
});

const parse = (html) => new JSDOM(html).window.document;

/** The open tags left over when `html` is read as a stack of stored elements, or the first mismatch. */
function unbalanced(html) {
	const stack = [];
	for (const [, close, name] of html.matchAll(/<(\/?)([a-z0-9]+)/g)) {
		if (["br", "col", "hr", "img", "wbr"].includes(name)) continue;
		if (!close) stack.push(name);
		else if (stack.pop() !== name) return `</${name}>`;
	}
	return stack.join();
}

test("nesting at the limit keeps every element", () => {
	const html = `${"<div>".repeat(MAX_OPEN_ELEMENTS)}text`;
	assert.equal(sanitizeStoredEmailHtml(html), `${html}${"</div>".repeat(MAX_OPEN_ELEMENTS)}`);
});

test("nesting past the limit closes what was opened and keeps the rest as text", () => {
	const html = `${"<div>".repeat(MAX_OPEN_ELEMENTS)}first<div>second<b>third</b><script>alert(1)</script>`;
	assert.equal(
		sanitizeStoredEmailHtml(html),
		`${"<div>".repeat(MAX_OPEN_ELEMENTS)}first${"</div>".repeat(MAX_OPEN_ELEMENTS)}` +
			'<div style="white-space: pre-wrap">second third  </div>',
	);
});

test("the limit counts unstored and dropped elements, whose content stays dropped", () => {
	const open = "<custom>".repeat(MAX_OPEN_ELEMENTS);
	assert.equal(sanitizeStoredEmailHtml(`${open}<b>x`), '<div style="white-space: pre-wrap">x</div>');
	assert.equal(sanitizeStoredEmailHtml(`<p>kept</p><svg>${"<g>".repeat(MAX_OPEN_ELEMENTS)}gone`), "<p>kept</p>");
});

test("cut output stays balanced and inert", () => {
	const open = "<div><span>".repeat(Math.floor(MAX_OPEN_ELEMENTS / 2));
	for (const payload of XSS_PAYLOADS) {
		const stored = sanitizeStoredEmailHtml(`${open}<b>${payload}${payload}`);
		assert.equal(unbalanced(stored), "", payload);
		assert.deepEqual(findActiveContent(stored, parse), [], payload);
		assert.equal(sanitizeStoredEmailHtml(stored), stored, payload);
	}
});

test("a body that ends inside an unfinished tag gets no closing tag for it", () => {
	assert.equal(sanitizeStoredEmailHtml('<p><a href="x">one<a href="unfin'), '<p><a href="x">one</a></p>');
	assert.equal(sanitizeStoredEmailHtml('<div><p>one<a title="'), "<div><p>one</p></div>");
	assert.equal(sanitizeStoredEmailHtml("<b><i>x</b>y</i>"), "<b><i>x</i></b>y");
});

test("too many attributes on one tag leave out its attributes only", () => {
	const names = Array.from({ length: MAX_TAG_ATTRIBUTES - 1 }, (_, index) => `data-a${index}="1"`).join(" ");
	const atLimit = `<p>one</p><a ${names} title="x">two</a><a title="y">three</a>`;
	assert.equal(sanitizeStoredEmailHtml(atLimit), atLimit);
	assert.equal(
		sanitizeStoredEmailHtml(`<p>one</p><a ${names} title="x" class="z">two</a><a title="y">three</a>`),
		'<p>one</p><a>two</a><a title="y">three</a>',
	);
});

test("output past its limit is cut and stays balanced", () => {
	const stored = sanitizeStoredEmailHtml(`<div><b>${"&".repeat(MAX_SANITIZED_HTML_CHARS / 4)}</b>after</div>`);
	assert.ok(stored.length >= MAX_SANITIZED_HTML_CHARS);
	assert.ok(stored.length < MAX_SANITIZED_HTML_CHARS + 512 * 1024);
	assert.ok(stored.endsWith("&amp;</b></div>"));
	const tags = sanitizeStoredEmailHtml(`<div>${"<p>".repeat(MAX_SANITIZED_HTML_CHARS / 2)}`);
	assert.ok(tags.length < MAX_SANITIZED_HTML_CHARS + 100);
	assert.ok(tags.endsWith("</p></div>"));
});

test("an attribute that outgrows the limit is left out", () => {
	assert.equal(sanitizeStoredEmailHtml(`<a title="${"&".repeat(MAX_SANITIZED_HTML_CHARS / 2)}">x</a>`), "<a>x</a>");
	const data = `data:image/png;base64,${"A".repeat(1_000_000)}`;
	assert.equal(sanitizeStoredEmailHtml(`<img src="${data}">`), `<img src="${data}">`);
});

test("attributes share the output limit, and those that do not fit are left out", () => {
	const quotes = '"'.repeat(MAX_SANITIZED_HTML_CHARS / 12);
	const escaped = "&quot;".repeat(quotes.length);
	const third = "x".repeat(10);
	assert.equal(
		sanitizeStoredEmailHtml(`<p title='${quotes}' class='${quotes}' lang='${quotes}' dir="${third}">x</p>`),
		`<p title="${escaped}" dir="${third}">x</p>`,
	);
	const exact = "x".repeat(MAX_SANITIZED_HTML_CHARS - '<p title="">'.length);
	assert.equal(sanitizeStoredEmailHtml(`<p title="${exact}">x</p>`).length, exact.length + '<p title=""></p>'.length);
	assert.equal(sanitizeStoredEmailHtml(`<p title="${exact}x">x</p>`), "<p>x</p>");
});

test("too many entities on one tag leave out its attributes only", () => {
	const entities = "&lt;".repeat(MAX_TAG_ENTITIES);
	const atLimit = `<p>one</p><a title="${entities}">two</a>`;
	assert.equal(sanitizeStoredEmailHtml(atLimit), atLimit);
	assert.equal(
		sanitizeStoredEmailHtml(`<p>one</p><a title="${entities}&lt;" href="/x">two</a><a title="y">three</a>`),
		'<p>one</p><a>two</a><a title="y">three</a>',
	);
	const half = "&lt;".repeat(MAX_TAG_ENTITIES / 2 + 1);
	assert.equal(sanitizeStoredEmailHtml(`<a title="${half}" class="${half}">two</a>`), "<a>two</a>");
	assert.equal(sanitizeStoredEmailHtml(`<div><zz y="${entities}&lt;">two</zz></div>`), "<div>two</div>");
	// A cut value never reaches the next tag, and an unsafe value is not kept in part.
	assert.equal(
		sanitizeStoredEmailHtml(`<a href="javascript:${entities}&lt;">one</a><a title="y">two</a>`),
		'<a>one</a><a title="y">two</a>',
	);
	// Each tag starts afresh, and text entities do not count.
	const perTag = `<a title="${entities}">a</a>`.repeat(2);
	assert.equal(sanitizeStoredEmailHtml(perTag), perTag);
	const text = `<p>${entities}${entities}</p>`;
	assert.equal(sanitizeStoredEmailHtml(text), text);
});

test("a dropped element at the nesting limit stays dropped", () => {
	const open = "<div>".repeat(MAX_OPEN_ELEMENTS);
	const close = "</div>".repeat(MAX_OPEN_ELEMENTS);
	for (const tag of ["style", "title", "svg", "script"]) {
		assert.equal(sanitizeStoredEmailHtml(`${open}<${tag}>gone</${tag}>`), `${open}${close}`, tag);
	}
});

test("output that reaches its limit while the parser finishes is closed too", () => {
	const stored = sanitizeStoredEmailHtml(`<div>${"x".repeat(MAX_SANITIZED_HTML_CHARS - 10)}&`);
	assert.ok(stored.endsWith("&amp;</div>"));
	assert.equal(unbalanced(stored), "");
});

test("long values are escaped and checked like short ones", () => {
	const long = '<&"é'.repeat(40_000);
	const stored = sanitizeStoredEmailHtml(`<p title='${long}'>${long.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>`);
	assert.equal(stored, `<p title="${"&lt;&amp;&quot;é".repeat(40_000)}">${'&lt;&amp;"é'.repeat(40_000)}</p>`);
	const padding = " \t\n".repeat(100_000);
	assert.equal(sanitizeStoredEmailHtml(`<a href="${padding}java${padding}script:alert(1)">x</a>`), "<a>x</a>");
	assert.equal(sanitizeStoredEmailHtml(`<a href="${"a".repeat(500)}:x">x</a>`), "<a>x</a>");
	assert.equal(sanitizeStoredEmailHtml(`<a href="${"a".repeat(500)}">x</a>`), `<a href="${"a".repeat(500)}">x</a>`);
	assert.equal(sanitizeStoredEmailHtml('<a href="HTTP://a.b">x</a>'), '<a href="HTTP://a.b">x</a>');
	assert.equal(sanitizeStoredEmailHtml('<a href=":x">x</a>'), '<a href=":x">x</a>');
	assert.equal(sanitizeStoredEmailHtml('<a href="1a:x">x</a>'), '<a href="1a:x">x</a>');
	assert.equal(sanitizeStoredEmailHtml('<a href="a+b.c-1:x">x</a>'), "<a>x</a>");
});

test("the root direction still needs a blank start", () => {
	assert.equal(sanitizeStoredEmailHtml('  <html dir="rtl"><body>x</body></html>'), '<div dir="rtl">  x</div>');
	assert.equal(sanitizeStoredEmailHtml('x<html dir="rtl">y'), "xy");
});
