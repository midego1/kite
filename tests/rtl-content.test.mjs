import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-rtl-content-");
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { buildEmailFrameDocument } from "./src/components/messages/email-html-frame-utils.ts";
			export { buildPrintDocument } from "./src/components/messages/print/print-document-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "rtl-content-test-entry.ts",
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
const { buildEmailFrameDocument, buildPrintDocument } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const ARABIC = "مرحبا بكم في كايت";
const HEBREW = "שלום וברוכים הבאים";

test("the email frame body follows the direction of the mail and keeps the sender's own dir", () => {
	for (const options of [{}, { dark: true }, { dark: true, original: true }, { muted: true }]) {
		const document = buildEmailFrameDocument(`<p>${ARABIC}</p><div dir="ltr">Order 42</div>`, options);
		assert.match(document, /<body dir="auto">/);
		assert.ok(document.includes('<div dir="ltr">Order 42</div>'), "the sender's dir attribute reaches the frame");
		assert.match(document, /color-scheme:(light|dark)/);
	}
	assert.equal((buildEmailFrameDocument(HEBREW).match(/<body\b/g) ?? []).length, 1);
});

test("the frame body takes the direction of a wrapper that holds the whole mail, and detects it otherwise", () => {
	const wrapped = buildEmailFrameDocument('<div dir="rtl"><table><tr><td>x</td></tr></table></div>');
	assert.match(wrapped, /<body dir="rtl">/);
	assert.match(buildEmailFrameDocument('<div dir="ltr"><p>مرحبا</p></div>'), /<body dir="ltr">/);
	assert.match(buildEmailFrameDocument('<div dir="rtl">a</div><p>b</p>'), /<body dir="auto">/);
	assert.match(buildEmailFrameDocument("<p>مرحبا</p>"), /<body dir="auto">/);
});

test("the frame's list and quote indents use logical properties, which equal the physical ones in left-to-right mail", () => {
	const document = buildEmailFrameDocument("<ul><li>a</li></ul>", { dark: true });
	assert.match(document, /ul\{[^}]*padding-inline-start:1\.5rem/);
	assert.match(document, /ol\{[^}]*padding-inline-start:1\.5rem/);
	assert.match(document, /blockquote\{border-inline-start:2px solid #d4d4d4;[^}]*padding-inline-start:\.75rem\}/);
	assert.match(document, /border-inline-start-color:#5f6368/);
	assert.doesNotMatch(document, /padding-left|border-left/);
});

test("a printed message reads right to left when its text does", () => {
	const message = {
		id: "1",
		subject: ARABIC,
		headers: [{ label: "From", value: `${HEBREW} <a@example.com>` }],
		attachments: [{ filename: "تقرير.pdf", size: "1 KB" }],
		html: null,
		text: ARABIC,
	};
	const html = buildPrintDocument({ title: ARABIC, messages: [message, { ...message, id: "2", subject: "Re: x" }] });
	assert.match(html, /<h1 class="print-title" dir="auto">/);
	assert.match(html, /<td dir="auto">/);
	assert.match(html, /<pre class="print-text" dir="auto">/);
	assert.match(html, /<h2 class="print-message-subject" dir="auto">Re: x<\/h2>/);
	assert.match(html, /<li dir="auto">تقرير\.pdf/);
	const withHtml = buildPrintDocument({ title: "x", messages: [{ ...message, html: `<p>${ARABIC}</p>` }] });
	assert.match(withHtml, /<div class="print-body" dir="auto"><p>/);
	assert.doesNotMatch(withHtml, /padding-left:1\.5rem|border-left:2px/);
	assert.match(withHtml, /\.print-attachments li\{margin-inline-start:18px\}/);
	assert.doesNotMatch(withHtml, /\.print-attachments ul\{[^}]*padding-(left|inline-start):18px/);
});
