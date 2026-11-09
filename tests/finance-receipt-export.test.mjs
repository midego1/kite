import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-finance-receipt-export-");
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: [
			`export * as htmlExport from "./src/lib/email/receipt-html-export-utils.ts";`,
			`export * as pdfExport from "./src/lib/email/receipt-pdf-utils.ts";`,
		].join("\n"),
		resolveDir: root,
		sourcefile: "receipt-export-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	absWorkingDir: root,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
});
const { htmlExport, pdfExport } = await import(pathToFileURL(join(directory, "entry.mjs")).href);
const { blankRemoteImages, blankRemoteStyleUrls, noopenerLinks, stripRemoteContent, buildReceiptHtmlDocument } =
	htmlExport;
const { paragraphsFromReadableText, buildReceiptPdfDocument } = pdfExport;

const HEADER = {
	fromName: "Hosting Co",
	fromAddress: "billing@hosting.example",
	subject: "Invoice INV-2041",
	dateText: "2026-10-28T00:00:00.000Z",
};

test("blankRemoteImages replaces every non-data image source, including cid: references", () => {
	const html = `<img src="https://evil.example/pixel.gif"><img src="//evil.example/x.png"><img src="cid:logo"><img src="data:image/png;base64,AAAA">`;
	const out = blankRemoteImages(html);
	assert.ok(!out.includes("evil.example"));
	assert.ok(!out.includes("cid:logo"));
	assert.equal(out.match(/data:image\/gif;base64/g)?.length, 3);
	assert.ok(out.includes("data:image/png;base64,AAAA"));
});

test("blankRemoteImages blanks the real src even when a data-src attribute comes first", () => {
	// The sanitizer keeps data-* attributes (inert: a browser never fetches them on its own), so this is a real
	// input. A naive `\bsrc="` pattern matches "data-src" too (`\b` fires between the hyphen and the "s" just
	// as readily as before a real `src`), consuming that attribute's value and leaving the actually-loaded
	// `src` — the one a browser or a less careful previewer does fetch — behind, untouched.
	const html = `<img data-src="https://evil.example/decoy.gif" src="https://evil.example/real.gif">`;
	const out = blankRemoteImages(html);
	const realSrc = out.match(/(?<![\w-])src="([^"]*)"/)?.[1];
	assert.ok(realSrc?.startsWith("data:"), `expected the real src to be blanked, got: ${out}`);
});

test("blankRemoteImages blanks the real src even when another attribute's value contains the literal text src=\" (S1')", () => {
	// A regex anchored on an attribute name, however carefully it avoids matching inside another attribute's
	// *name* (the data-src case above), still cannot tell that name from the same literal text sitting inside
	// a *value* the sanitizer keeps verbatim (alt, title): `<img alt="pay src=" ... src="real">` reads, to a
	// regex, as if "pay src=" had opened a second src attribute. A real parser never makes this mistake, since
	// it tracks attribute boundaries, not substrings.
	const html = `<img alt="pay src=" width="1" src="https://e.example/4c">`;
	const out = blankRemoteImages(html);
	assert.ok(!out.includes("e.example"), `expected the real src to be blanked, got: ${out}`);
});

test("noopenerLinks adds rel even when another attribute's value contains the literal text rel=\" (S1')", () => {
	const html = `<a href="https://evil.example" title="see rel=" target="_blank">a</a>`;
	const out = noopenerLinks(html);
	assert.match(out, /rel="noopener noreferrer"/, `expected rel to be added, got: ${out}`);
});

test("blankRemoteStyleUrls drops the whole style value with a remote url(), but keeps a bare data: one", () => {
	const html = `<div style="background:url('https://evil.example/bg.png')">x</div><div style="background:url(data:image/png;base64,AAAA)">y</div>`;
	const out = blankRemoteStyleUrls(html);
	assert.ok(!out.includes("evil.example"));
	assert.ok(out.includes('<div style="">x</div>'));
	assert.ok(out.includes("data:image/png;base64,AAAA"));
});

test("blankRemoteStyleUrls drops a style value whose data: claim does not actually start the url() content", () => {
	const html = `<div style="background:url(https://evil.example/data:fake)">x</div>`;
	assert.ok(!blankRemoteStyleUrls(html).includes("evil.example"));
});

test("blankRemoteStyleUrls catches the four bypasses of the naive quoted-url blocklist", () => {
	const cases = [
		// &quot; is what the stored-mail sanitizer writes for a literal quote in an attribute value.
		`<div style="background:url(&quot;https://evil.example/p.gif&quot;)">x</div>`,
		// A CSS backslash escape inside the function name itself.
		`<div style="background:u\\72l(https://evil.example/p.gif)">x</div>`,
		// A CSS backslash escape inside the URL.
		`<div style="background:url(\\68ttps://evil.example/p.gif)">x</div>`,
		// image-set() is a second CSS function that can fetch a remote image.
		`<div style="background-image:image-set('https://evil.example/p.gif' 1x)">x</div>`,
	];
	for (const html of cases) {
		const out = blankRemoteStyleUrls(html);
		assert.ok(!out.includes("evil.example"), html);
	}
});

test("blankRemoteStyleUrls leaves an ordinary style value with no url-like content untouched", () => {
	const html = `<div style="color: red; font-weight: bold">x</div>`;
	assert.equal(blankRemoteStyleUrls(html), html);
});

test("noopenerLinks adds noopener noreferrer to a target-opened link and keeps the other rel tokens", () => {
	const html = `<a href="https://a.example" target="_blank">a</a><a href="https://b.example" target="_blank" rel="nofollow">b</a>`;
	const out = noopenerLinks(html);
	assert.match(out, /<a href="https:\/\/a\.example" target="_blank" rel="noopener noreferrer">a<\/a>/);
	assert.match(out, /<a href="https:\/\/b\.example" target="_blank" rel="nofollow noopener noreferrer">b<\/a>/);
});

test("noopenerLinks completes a partial rel and drops opener, which would keep window.opener reachable", () => {
	const html = [
		`<a href="https://a.example" target="_blank" rel="noopener">a</a>`,
		`<a href="https://b.example" target="_blank" rel="opener nofollow">b</a>`,
		`<a href="https://c.example" target="_blank" rel="NoReferrer">c</a>`,
		`<a href="https://d.example" target="_blank" rel="noopener noreferrer">d</a>`,
	].join("");
	const out = noopenerLinks(html);
	assert.match(out, /href="https:\/\/a\.example" target="_blank" rel="noopener noreferrer"/);
	assert.match(out, /href="https:\/\/b\.example" target="_blank" rel="nofollow noopener noreferrer"/);
	assert.match(out, /href="https:\/\/c\.example" target="_blank" rel="noreferrer noopener"/);
	assert.match(out, /href="https:\/\/d\.example" target="_blank" rel="noopener noreferrer"/);
	assert.ok(!/\bopener(?!\w)/.test(out.replace(/noopener/g, "")), out);
});

test("noopenerLinks leaves a link with no target alone", () => {
	const html = `<a href="https://a.example" rel="opener">a</a>`;
	assert.equal(noopenerLinks(html), html);
});

test("stripRemoteContent drops raw-text elements with their content instead of printing it as text", () => {
	const html = `<p>Hello</p><style>body { background: url(https://evil.example/p.gif) }</style><textarea>secret <b>x</b></textarea><p>World</p>`;
	const out = stripRemoteContent(html);
	assert.equal(out, "<p>Hello</p><p>World</p>");
});

test("noopenerLinks adds rel even when a data-rel attribute comes first, instead of reading it as already having one", () => {
	// Same bypass shape as the img src one above: a naive `\brel="` pattern matches inside "data-rel=" too, so
	// a link with only a data-rel attribute (the sanitizer keeps data-* attributes) read as "already has a
	// rel" and kept window.opener reachable through target="_blank".
	const html = `<a href="https://evil.example" target="_blank" data-rel="nofollow">a</a>`;
	const out = noopenerLinks(html);
	assert.match(out, /rel="noopener noreferrer"/, `expected rel to be added, got: ${out}`);
});

test("stripRemoteContent leaves a fully local body untouched beyond link rel", () => {
	const html = `<p>Hello <b>world</b></p><img src="data:image/png;base64,AAAA">`;
	assert.equal(stripRemoteContent(html), html);
});

test("buildReceiptHtmlDocument is self-contained: no remote image reference, header shown and escaped", () => {
	const body = `<p>Amount due <b>€120.00</b></p><img src="https://evil.example/track.gif">`;
	const doc = buildReceiptHtmlDocument(HEADER, body);
	assert.ok(!doc.includes("evil.example"));
	assert.ok(doc.startsWith("<!doctype html>"));
	assert.ok(doc.includes("<title>Invoice INV-2041</title>"));
	assert.ok(doc.includes("Hosting Co &lt;billing@hosting.example&gt;"));
	assert.ok(doc.includes("€120.00"));
});

test("buildReceiptHtmlDocument sets a Content-Security-Policy that blocks anything but an inlined image", () => {
	const doc = buildReceiptHtmlDocument(HEADER, "<p>Body</p>");
	assert.match(doc, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:;/);
});

test("buildReceiptHtmlDocument contains the body so a sender's position: fixed/absolute cannot cover the header", () => {
	const doc = buildReceiptHtmlDocument(HEADER, `<p style="position:fixed">fake header</p>`);
	assert.match(doc, /\.kite-receipt-body\s*\{[^}]*contain:\s*paint/);
});

test("buildReceiptHtmlDocument escapes a subject with HTML-significant characters", () => {
	const doc = buildReceiptHtmlDocument({ ...HEADER, subject: '<b>Hi</b> & "quote"' }, "<p>Body</p>");
	assert.ok(doc.includes('&lt;b&gt;Hi&lt;/b&gt; &amp; "quote"'));
	assert.ok(!doc.includes("<title><b>"));
});

test("buildReceiptHtmlDocument falls back to the bare address with no sender name, and to a placeholder subject", () => {
	const doc = buildReceiptHtmlDocument({ ...HEADER, fromName: null, subject: null }, "<p>Body</p>");
	assert.ok(doc.includes("<title>(no subject)</title>"));
	assert.ok(doc.includes("<dd>billing@hosting.example</dd>"));
});

test("paragraphsFromReadableText keeps quote depth from leading '>' markers", () => {
	const text = "Hello\n> quoted once\n>> quoted twice\nback to normal";
	assert.deepEqual(paragraphsFromReadableText(text), [
		{ text: "Hello", depth: 0 },
		{ text: "quoted once", depth: 1 },
		{ text: "quoted twice", depth: 2 },
		{ text: "back to normal", depth: 0 },
	]);
});

test("buildReceiptPdfDocument falls back to the HTML's readable text when there is no text body", () => {
	const doc = buildReceiptPdfDocument(HEADER, null, "<p>Amount due <b>€120.00</b></p>");
	assert.equal(doc.title, "Invoice INV-2041");
	const bodyBlock = doc.blocks.find((block) => block.text?.includes("€120.00"));
	assert.ok(bodyBlock, "the HTML-derived text should appear as a block");
});

test("buildReceiptPdfDocument prefers the plain-text body over the HTML", () => {
	const doc = buildReceiptPdfDocument(HEADER, "Plain text body", "<p>HTML body</p>");
	assert.ok(doc.blocks.some((block) => block.text === "Plain text body"));
	assert.ok(!doc.blocks.some((block) => block.text?.includes("HTML body")));
});

test("buildReceiptPdfDocument falls back to the bare address with no sender name, and to a placeholder subject", () => {
	const doc = buildReceiptPdfDocument({ ...HEADER, fromName: null, subject: null }, "Body", null);
	assert.equal(doc.title, "(no subject)");
	assert.ok(doc.blocks.some((block) => block.text === "From: billing@hosting.example"));
});
