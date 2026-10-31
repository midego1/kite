import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-text-pdf-");
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/pdf/text-pdf-utils.ts")],
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
});
const { buildTextPdf, measureText, pdfString, pdfUnicodeString, toWinAnsi, wrapText } = await import(
	pathToFileURL(join(directory, "entry.mjs")).href
);

const latin1 = (bytes) => Buffer.from(bytes).toString("latin1");

test("Western European text is kept as Windows-1252 bytes", () => {
	assert.deepEqual(toWinAnsi("Café déjà vu"), { text: "Café déjà vu", lost: 0 });
	const typographic = toWinAnsi("“Quote” – €5 … ™ •");
	assert.equal(typographic.lost, 0);
	assert.deepEqual(
		[...typographic.text].map((char) => char.charCodeAt(0)),
		[0x93, 0x51, 0x75, 0x6f, 0x74, 0x65, 0x94, 0x20, 0x96, 0x20, 0x80, 0x35, 0x20, 0x85, 0x20, 0x99, 0x20, 0x95],
	);
});

test("characters outside Windows-1252 get a stand-in or a question mark and are counted", () => {
	assert.deepEqual(toWinAnsi("a−b → c"), { text: "a-b -> c", lost: 0 });
	assert.deepEqual(toWinAnsi("Łódź"), { text: "Lódz", lost: 1 });
	assert.deepEqual(toWinAnsi("Zażółć"), { text: "Zazólc", lost: 2 });
	assert.deepEqual(toWinAnsi("日本"), { text: "??", lost: 2 });
	// Emoji leave no question mark behind; joiners and variation selectors vanish without counting.
	assert.deepEqual(toWinAnsi("Hi 👋🏽 ❤️ ok"), { text: "Hi   ok", lost: 3 });
	assert.deepEqual(toWinAnsi("a​b\tc\u0007"), { text: "ab    c", lost: 0 });
});

test("widths follow the Helvetica metrics", () => {
	assert.equal(measureText("Hello", 10), 22.78);
	assert.equal(measureText("Hello", 10, true), 24.45);
	// Accented letters are as wide as their letter, WinAnsi symbols have their own width.
	assert.equal(measureText("é", 10), measureText("e", 10));
	assert.equal(measureText(toWinAnsi("—").text, 10), 10);
	assert.equal(measureText(toWinAnsi("Œ").text, 10), 10);
	assert.equal(measureText(" ", 10), 2.78);
	assert.equal(measureText("½", 10), 5.56);
});

test("lines wrap at spaces, keep line breaks and split words only when they do not fit", () => {
	assert.deepEqual(wrapText("one two three four", measureText("one two three", 10), 10), ["one two three", "four"]);
	assert.deepEqual(wrapText("first\n\nthird", 500, 10), ["first", "", "third"]);
	assert.deepEqual(wrapText("", 500, 10), [""]);
	const link = "https://example.com/" + "a".repeat(80);
	const lines = wrapText(`see ${link}`, 120, 10);
	assert.equal(lines[0], "see");
	assert.equal(lines.slice(1).join(""), link);
	for (const line of lines) assert.ok(measureText(line, 10) <= 120);
	assert.deepEqual(wrapText("abc", 1, 10), ["a", "b", "c"]);
	// Leading spaces (indented text) count towards the width and survive; a word that does not fit after them
	// starts the next line without a blank one before it.
	assert.deepEqual(wrapText("    code", 500, 10), ["    code"]);
	assert.deepEqual(wrapText("  wide", measureText("wide", 10), 10), ["wide"]);
	assert.deepEqual(wrapText("ab cd  ", measureText("ab cd", 10), 10), ["ab cd"]);
	assert.deepEqual(wrapText(`${"a".repeat(30)} b`, measureText("a".repeat(12), 10), 10), [
		"a".repeat(12),
		"a".repeat(12),
		"a".repeat(6) + " b",
	]);
});

test("a very long word wraps in linear time", () => {
	const word = "?".repeat(1_000_000);
	const started = performance.now();
	const lines = wrapText(word, 483, 10.5);
	assert.ok(performance.now() - started < 2000, `took ${Math.round(performance.now() - started)} ms`);
	assert.equal(lines.join(""), word);
	assert.ok(lines.every((line) => measureText(line, 10.5) <= 483));
	assert.ok(measureText(lines[0] + "?", 10.5) > 483);
});

test("strings are escaped for PDF", () => {
	assert.equal(pdfString("a(b)c\\d"), "(a\\(b\\)c\\\\d)");
	assert.equal(pdfString("é\u0080"), "(\\351\\200)");
	assert.equal(pdfUnicodeString("Aé€"), "<FEFF004100E920AC>");
});

test("a text PDF is a well-formed file whose cross-reference table points at every object", () => {
	const result = buildTextPdf({
		title: "Größe (1)",
		blocks: [
			{ text: "Subject", size: 16, bold: true },
			{ rule: true, spaceBefore: 14 },
			{ text: "Body with (parentheses) and a back\\slash", grey: 0.4, indent: 12, spaceBefore: 4 },
		],
	});
	assert.equal(result.pages, 1);
	assert.equal(result.lost, 0);
	const text = latin1(result.bytes);
	assert.ok(text.startsWith("%PDF-1.4\n"));
	assert.ok(text.endsWith("%%EOF\n"));
	assert.match(text, /\/Title <FEFF0047007200F600DF00650020002800310029>/);
	assert.match(text, /\/BaseFont \/Helvetica-Bold \/Encoding \/WinAnsiEncoding/);
	assert.match(text, /\(Body with \\\(parentheses\\\) and a back\\\\slash\) Tj/);
	assert.match(text, / l S/);

	const startxref = Number(/startxref\n(\d+)\n/.exec(text)[1]);
	assert.ok(text.slice(startxref).startsWith("xref\n"));
	const [, count] = /xref\n0 (\d+)\n/.exec(text.slice(startxref));
	const entries = text
		.slice(startxref)
		.split("\n")
		.slice(3, 2 + Number(count));
	entries.forEach((entry, index) => {
		const offset = Number(entry.slice(0, 10));
		assert.ok(text.slice(offset).startsWith(`${index + 1} 0 obj\n`), `object ${index + 1} at ${offset}`);
	});
	const length = Number(/\/Length (\d+) >>\nstream\n/.exec(text)[1]);
	const streamStart = text.indexOf("stream\n") + "stream\n".length;
	assert.equal(text.slice(streamStart + length), text.slice(text.indexOf("\nendstream", streamStart)));
});

test("line breaks inside a block become separate lines of text", () => {
	const text = latin1(buildTextPdf({ title: "Breaks", blocks: [{ text: "Kind regards,\nJohn" }] }).bytes);
	assert.match(text, /\(Kind regards,\) Tj/);
	assert.match(text, /\(John\) Tj/);
	assert.doesNotMatch(text, /regards,John/);
});

test("long text flows onto further pages and lost characters are reported", () => {
	const blocks = Array.from({ length: 120 }, (_, index) => ({ text: `Line ${index} 日` }));
	const result = buildTextPdf({ title: "Long", blocks });
	assert.equal(result.pages, 3);
	assert.equal(result.lost, 120);
	const text = latin1(result.bytes);
	assert.match(text, /\/Count 3 \/Kids \[6 0 R 8 0 R 10 0 R\]/);
	assert.match(text, /\(Line 119 \?\) Tj/);
	// A block's space above is dropped at the top of a page.
	const spaced = buildTextPdf({ title: "Spaced", blocks: [{ text: "Top", spaceBefore: 40 }] });
	assert.match(latin1(spaced.bytes), / 56 775\.65 Td \(Top\) Tj/);
});
