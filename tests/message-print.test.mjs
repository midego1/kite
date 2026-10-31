import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-message-print-");
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export * from "./src/components/messages/print/print-document-utils.ts";
			export * from "./src/components/messages/print/message-pdf-utils.ts";
			export { buildTextPdf } from "./src/lib/pdf/text-pdf-utils.ts";
			export { createEmailHtmlSanitizer } from "./src/app/(dashboard)/inbox/[messageId]/email-html-sanitizer-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "message-print-test-entry.ts",
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
const {
	buildPrintDocument,
	buildTextPdf,
	createEmailHtmlSanitizer,
	formatPrintAddresses,
	messagePdfBlocks,
	orderForPrint,
	paragraphsFromHtml,
	paragraphsFromText,
	pdfFileName,
	printHeaderRows,
	toPrintMessage,
} = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const { window } = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://kite.example/inbox" });
const sanitize = createEmailHtmlSanitizer(window);
const parse = (html) => new window.DOMParser().parseFromString(html, "text/html").body;
const formatDate = (value) => `date:${value}`;

test("the PDF file name is the subject without characters file systems refuse", () => {
	assert.equal(pdfFileName("Invoice 2026/10: paid?"), "Invoice 2026 10 paid.pdf");
	assert.equal(pdfFileName('  Re: "Plans" <draft> | v2  '), "Re Plans draft v2.pdf");
	assert.equal(pdfFileName("Tab\tand\nnewline"), "Tab and newline.pdf");
	assert.equal(pdfFileName("Café déjà vu 🎉"), "Café déjà vu 🎉.pdf");
	assert.equal(pdfFileName("...hidden..."), "hidden.pdf");
	assert.equal(pdfFileName(null), "Email.pdf");
	assert.equal(pdfFileName("  "), "Email.pdf");
	assert.equal(pdfFileName("???"), "Email.pdf");
	assert.equal(pdfFileName("CON"), "CON email.pdf");
	// Bidirectional overrides would show "Invoice \u202Efdp.exe" reversed; zero-width characters vanish too.
	assert.equal(pdfFileName("Invoice \u202Eexe.pdf\u202C"), "Invoice exe.pdf.pdf");
	assert.equal(pdfFileName("\u2066Re\u2069: \u200Ehi\u200F\u200B"), "Re hi.pdf");
	assert.equal(pdfFileName("lpt1"), "lpt1 email.pdf");
	const long = pdfFileName(`${"word ".repeat(30)}end`);
	assert.equal(long, `${"word ".repeat(20).trim()}.pdf`);
	// Long names are cut by characters, never inside an emoji.
	assert.equal(pdfFileName("😀".repeat(120)), `${"😀".repeat(100)}.pdf`);
});

test("address headers list every recipient with its name", () => {
	assert.equal(
		formatPrintAddresses('"Ann Example" <ann@example.com>, bob@example.com, Carl <carl@example.com>'),
		"Ann Example <ann@example.com>, bob@example.com, Carl <carl@example.com>",
	);
	assert.equal(formatPrintAddresses(null), "");
	assert.equal(formatPrintAddresses(""), "");
});

test("header rows follow mail client order and skip empty ones", () => {
	assert.deepEqual(
		printHeaderRows({ from: "Ann <ann@example.com>", to: "me@example.com", cc: "", bcc: null, date: "Fri 31 Oct" }),
		[
			{ label: "From", value: "Ann <ann@example.com>" },
			{ label: "To", value: "me@example.com" },
			{ label: "Date", value: "Fri 31 Oct" },
		],
	);
	assert.deepEqual(
		printHeaderRows({ from: "a@x.test", to: "b@x.test", cc: "c@x.test", bcc: "d@x.test", date: "" }).map(
			(row) => row.label,
		),
		["From", "To", "Cc", "Bcc"],
	);
});

test("a conversation prints each message once, oldest first", () => {
	const ordered = orderForPrint([
		{ id: "b", createdAt: "2026-10-02T10:00:00Z", copy: "thread" },
		{ id: "a", createdAt: "2026-10-01T10:00:00Z", copy: "thread" },
		{ id: "b", createdAt: "2026-10-02T10:00:00Z", copy: "open" },
	]);
	assert.deepEqual(
		ordered.map((message) => `${message.id}:${message.copy}`),
		["a:thread", "b:open"],
	);
});

const source = {
	id: "m1",
	subject: " Quarterly <report> ",
	fromAddr: '"Ann" <ann@example.com>',
	toAddr: "me@example.com",
	ccAddr: "team@example.com",
	createdAt: "2026-10-31T09:00:00Z",
	snippet: "snippet",
	textBody: "plain body",
	htmlBody:
		'<p>Hello <b>there</b></p><script>alert(1)</script><img src="https://tracker.example/p.png" alt="t"><img src="cid:logo@x" alt="logo"><blockquote><p>older</p></blockquote>',
	attachments: [
		{
			id: "a1",
			messageId: "m1",
			filename: "report.pdf",
			size: 2048,
			type: "application/pdf",
			contentId: null,
			disposition: "attachment",
		},
		{
			id: "a2",
			messageId: "m1",
			filename: "logo.png",
			size: 10,
			type: "image/png",
			contentId: "<logo@x>",
			disposition: "inline",
		},
	],
	blockRemoteImages: true,
};

test("a printed message uses the reader's sanitizer and keeps remote images blocked", () => {
	const message = toPrintMessage(source, { sanitize, formatDate });
	assert.equal(message.subject, "Quarterly <report>");
	assert.deepEqual(message.headers.at(-1), { label: "Date", value: "date:2026-10-31T09:00:00Z" });
	assert.deepEqual(message.attachments, [{ filename: "report.pdf", size: "2 KB" }]);
	assert.doesNotMatch(message.html, /script|alert/);
	assert.doesNotMatch(message.html, /tracker\.example/);
	// Inline attachments resolve to Kite's own attachment URL, and the quoted history is not folded away.
	assert.match(message.html, /\/api\/messages\/m1\/attachments\/a2\?preview=1/);
	assert.match(message.html, /<blockquote>/);
	assert.doesNotMatch(message.html, /<details/);
	assert.equal(message.text, "plain body");

	const shown = toPrintMessage({ ...source, blockRemoteImages: false }, { sanitize, formatDate });
	assert.match(shown.html, /\/api\/remote-images\?/);
});

test("a text-only message prints its text, falling back to the snippet", () => {
	const text = toPrintMessage({ ...source, htmlBody: null, attachments: undefined }, { sanitize, formatDate });
	assert.equal(text.html, null);
	assert.equal(text.text, "plain body");
	assert.deepEqual(text.attachments, []);
	const snippet = toPrintMessage(
		{ ...source, htmlBody: "<script></script>", textBody: null },
		{ sanitize, formatDate },
	);
	assert.equal(snippet.html, null);
	assert.equal(snippet.text, "snippet");
	assert.equal(
		toPrintMessage({ ...source, htmlBody: null, textBody: null, snippet: null }, { sanitize, formatDate }).text,
		"",
	);
});

test("the print document escapes everything but the sanitized body and allows no scripts", () => {
	const message = toPrintMessage(source, { sanitize, formatDate });
	const html = buildPrintDocument({ title: message.subject, messages: [message] });
	assert.match(
		html,
		/<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'">/,
	);
	assert.match(html, /<title>Quarterly &lt;report&gt;<\/title>/);
	assert.match(html, /<h1 class="print-title">Quarterly &lt;report&gt;<\/h1>/);
	assert.match(html, /<th scope="row">From<\/th><td>Ann &lt;ann@example.com&gt;<\/td>/);
	assert.match(html, /<li>report\.pdf <span class="print-attachment-size">\(2 KB\)<\/span><\/li>/);
	assert.match(html, /<p>Hello <b>there<\/b><\/p>/);
	assert.match(html, /color-scheme:light/);
	assert.doesNotMatch(html, /class="print-count"/);
	// Lazy images would not load in the hidden print frame before the dialog opens.
	assert.doesNotMatch(html, /loading=/);

	const doc = new JSDOM(html).window.document;
	assert.equal(doc.querySelectorAll("script").length, 0);
	assert.equal(doc.querySelectorAll("article.print-message").length, 1);
});

test("a conversation document numbers its messages and names a changed subject", () => {
	const first = { id: "1", subject: "Plans", headers: [], attachments: [], html: null, text: "<b>not bold</b>" };
	const second = { ...first, id: "2", subject: "Re: Plans", text: "second" };
	const html = buildPrintDocument({ title: "Plans", messages: [first, second] });
	assert.match(html, /2 messages in this conversation/);
	assert.match(html, /<pre class="print-text">&lt;b&gt;not bold&lt;\/b&gt;<\/pre>/);
	assert.match(html, /<h2 class="print-message-subject">Re: Plans<\/h2>/);
	assert.equal((html.match(/print-message-subject/g) ?? []).length - 1, 1);
	assert.match(buildPrintDocument({ title: " ", messages: [] }), /<h1 class="print-title">\(no subject\)<\/h1>/);
});

test("HTML bodies become paragraphs with lists, headings and quote depth", () => {
	const paragraphs = paragraphsFromHtml(
		parse(
			'<h2>Title</h2><p>One  <i>two</i><br>three</p><ul><li>apple</li><li>pear</li></ul><ol start="3"><li>third</li><li>fourth</li></ol>' +
				"<table><tr><td>cell a</td><td>cell b</td></tr></table><hr><blockquote><p>quoted</p><blockquote>deeper</blockquote></blockquote>" +
				'<pre>keep   spaces</pre><img src="x" alt="pic">tail',
		),
	);
	assert.deepEqual(paragraphs, [
		{ text: "Title", depth: 0, bold: true },
		{ text: "One two\nthree", depth: 0, bold: false },
		{ text: "• apple", depth: 0, bold: false },
		{ text: "• pear", depth: 0, bold: false },
		{ text: "3. third", depth: 0, bold: false },
		{ text: "4. fourth", depth: 0, bold: false },
		{ text: "cell a cell b", depth: 0, bold: false },
		{ text: "quoted", depth: 1, bold: false },
		{ text: "deeper", depth: 2, bold: false },
		{ text: "keep   spaces", depth: 0, bold: false },
		{ text: "tail", depth: 0, bold: false },
	]);
});

test("hidden preview text is left out and list markers stay with their item's text", () => {
	const paragraphs = paragraphsFromHtml(
		parse(
			'<div style="display: none; max-height: 0">Preview text</div><span style="mso-hide:all">Outlook only</span>' +
				'<p style="display:block">Shown</p><ul><li><p>Item in a paragraph</p><p>second paragraph</p></li><li></li><li><div><b>Bold</b> item</div></li></ul>' +
				"<pre>  indented\n    more</pre><p>Kind regards,<br>John</p>",
		),
	);
	assert.deepEqual(paragraphs, [
		{ text: "Shown", depth: 0, bold: false },
		{ text: "• Item in a paragraph", depth: 0, bold: false },
		{ text: "second paragraph", depth: 0, bold: false },
		{ text: "• Bold item", depth: 0, bold: false },
		{ text: "  indented\n    more", depth: 0, bold: false },
		{ text: "Kind regards,\nJohn", depth: 0, bold: false },
	]);
});

test("text bodies keep their lines and turn > quoting into depth", () => {
	assert.deepEqual(paragraphsFromText("Hi\r\n\r\n> quoted\n>> deeper\n> > spaced\n"), [
		{ text: "Hi", depth: 0, bold: false },
		{ text: "", depth: 0, bold: false },
		{ text: "quoted", depth: 1, bold: false },
		{ text: "deeper", depth: 2, bold: false },
		{ text: "spaced", depth: 2, bold: false },
	]);
});

test("PDF blocks hold the subject, headers, attachments and body of every message", () => {
	const message = toPrintMessage(source, { sanitize, formatDate });
	const textOnly = {
		...message,
		id: "m2",
		subject: "Re: Quarterly <report>",
		html: null,
		text: "> earlier",
		attachments: [],
	};
	const blocks = messagePdfBlocks({ title: message.subject, messages: [message, textOnly] }, parse);
	const texts = blocks.filter((block) => block.text !== undefined).map((block) => block.text);
	assert.deepEqual(texts.slice(0, 2), ["Quarterly <report>", "2 messages in this conversation"]);
	assert.ok(texts.includes("From: Ann <ann@example.com>"));
	assert.ok(texts.includes("Attachments (1)"));
	assert.ok(texts.includes("• report.pdf (2 KB)"));
	assert.ok(texts.includes("Hello there"));
	assert.ok(texts.includes("Re: Quarterly <report>"));
	assert.equal(blocks.filter((block) => block.rule).length, 2);
	const quoted = blocks.find((block) => block.text === "older");
	assert.equal(quoted.indent, 12);
	assert.equal(quoted.grey, 0.4);
	const earlier = blocks.find((block) => block.text === "earlier");
	assert.equal(earlier.spaceBefore, 12);
	assert.deepEqual(messagePdfBlocks({ title: "", messages: [] }, parse), [
		{ text: "(no subject)", size: 16, bold: true },
	]);
});

test("line breaks in an HTML body reach the PDF as separate lines", () => {
	const message = toPrintMessage(
		{ ...source, htmlBody: "<p>Thanks for the update.</p><p>Kind regards,<br>John<br>ACME</p>", attachments: [] },
		{ sanitize, formatDate },
	);
	const pdf = buildTextPdf({
		title: message.subject,
		blocks: messagePdfBlocks({ title: message.subject, messages: [message] }, parse),
	});
	const text = Buffer.from(pdf.bytes).toString("latin1");
	for (const line of ["Thanks for the update.", "Kind regards,", "John", "ACME"])
		assert.ok(text.includes(`(${line}) Tj`), `${line} is its own line`);
	assert.doesNotMatch(text, /regards,John/);
});
