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

test("blankRemoteStyleUrls removes a remote url() but keeps data: and relative values", () => {
	const html = `<div style="background:url('https://evil.example/bg.png')">x</div><div style="background:url(data:image/png;base64,AAAA)">y</div>`;
	const out = blankRemoteStyleUrls(html);
	assert.ok(!out.includes("evil.example"));
	assert.ok(out.includes("background:none"));
	assert.ok(out.includes("data:image/png;base64,AAAA"));
});

test("noopenerLinks adds rel to a target-opened link without touching an existing rel", () => {
	const html = `<a href="https://a.example" target="_blank">a</a><a href="https://b.example" target="_blank" rel="nofollow">b</a>`;
	const out = noopenerLinks(html);
	assert.match(out, /<a href="https:\/\/a\.example" target="_blank" rel="noopener noreferrer">a<\/a>/);
	assert.match(out, /<a href="https:\/\/b\.example" target="_blank" rel="nofollow">b<\/a>/);
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
