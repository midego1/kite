import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

// Text and HTML parts are cut to a decoded size before postal-mime turns them into strings. The large cases run in a
// child process with a 64 MB heap, half of what the other bounds tests allow, so the room this leaves a Worker for the
// raw message and its decoded parts shows up as a failed child when it shrinks.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-decoded-body-bounds-");
after(() => rmSync(directory, { recursive: true, force: true }));

const entry = join(directory, "entry.ts");
writeFileSync(
	entry,
	`
export { buildSnippet, parseRawMime } from "${root}/src/lib/email/parse";
export { MAX_DECODED_TEXT_BYTES, decodedTextCut } from "${root}/src/lib/email/mime-body-utils";
export { wrappedRootDirection } from "${root}/src/lib/email/root-direction-utils";
`,
);
const bundle = join(directory, "entry.mjs");
await build({
	entryPoints: [entry],
	outfile: bundle,
	sourcemap: "inline",
	bundle: true,
	absWorkingDir: root,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const { MAX_DECODED_TEXT_BYTES, decodedTextCut, parseRawMime, wrappedRootDirection } = await import(
	pathToFileURL(bundle).href
);
const MiB = 1024 * 1024;
const NOTE =
	"This message is longer than Kite shows. The rest is in the original message: use Show original to download it.";
const TEXT_NOTE = `\n\n[${NOTE}]`;
const HTML_NOTE = `<hr><p>${NOTE}</p>`;

test("the decoded limits are 2 MiB of text and 4 MiB of HTML", () => {
	assert.deepEqual({ ...MAX_DECODED_TEXT_BYTES }, { plain: 2 * MiB, html: 4 * MiB });
});

const worker = join(directory, "worker.mjs");
writeFileSync(
	worker,
	`
import { buildSnippet, parseRawMime } from ${JSON.stringify(pathToFileURL(bundle).href)};

const header = "From: a@example.com\\r\\nTo: b@example.com\\r\\nSubject: x\\r\\nMIME-Version: 1.0\\r\\n";
const MiB = 1024 * 1024;
// 24 MB of 200-byte lines of \`unit\`, kept a one-byte string here so only the parser holds two-byte copies.
const body = (size, unit) => (unit.repeat(Math.ceil(198 / unit.length)).slice(0, 198) + "\\r\\n").repeat(Math.floor(size / 200));
const encode = (pieces, charset = "utf8") => {
	const bytes = Buffer.concat(pieces.map((piece) => Buffer.from(piece, charset)));
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};
const single = (type, ...content) => [header + "Content-Type: " + type + "\\r\\n\\r\\n", ...content];
const part = (type, ...content) => ["--B\\r\\nContent-Type: " + type + "\\r\\n\\r\\n", ...content, "\\r\\n"];
const multi = (kind, ...parts) => [header + "Content-Type: multipart/" + kind + '; boundary="B"\\r\\n\\r\\n', ...parts.flat(), "--B--\\r\\n"];
const base64 = (...pieces) => Buffer.concat(pieces.map((piece) => Buffer.from(piece))).toString("base64").replace(/.{76}/g, "$&\\r\\n");
const euro = "\\u20ac";
const words = "abcd efgh ";
const cyrillic = "\\xb0\\xb1\\xb2\\xb3 \\xd0\\xd1\\xd2 ";
const full = 24 * MiB;
const half = 12 * MiB;
const shapes = {
	text: () => encode(single("text/plain; charset=utf-8", euro, body(full, words))),
	textSingleByteCharset: () => encode(single("text/plain; charset=iso-8859-5", body(full, cyrillic)), "latin1"),
	textBase64: () => encode(single("text/plain; charset=utf-8\\r\\nContent-Transfer-Encoding: base64", base64(euro, body(18 * MiB, words)))),
	html: () => encode(single("text/html; charset=utf-8", "<p>", euro, body(full, words))),
	htmlSingleByteCharset: () => encode(single("text/html; charset=iso-8859-5", "<p>", body(full, cyrillic)), "latin1"),
	htmlBrackets: () => encode(single("text/html; charset=utf-8", "<p>", euro, body(full, "< "))),
	htmlAmpersands: () => encode(single("text/html; charset=utf-8", "<p>", euro, body(full, "& "))),
	alternative: () => encode(multi("alternative", part("text/plain; charset=utf-8", euro, body(half, words)), part("text/html; charset=utf-8", "<p>", euro, body(half, words)))),
	alternativeBrackets: () => encode(multi("alternative", part("text/plain; charset=utf-8", euro, body(half, words)), part("text/html; charset=utf-8", "<p>", euro, body(half, "< ")))),
	mixedBrackets: () => encode(multi("mixed", part("text/plain; charset=utf-8", euro, body(half, words)), part("text/html; charset=utf-8", "<p>", euro, body(half, "< ")))),
	mixedHtml: () => encode(multi("mixed", part("text/plain", "hi"), part("text/html; charset=utf-8", "<p>", euro, body(full, words)))),
	mixedHtmlSingleByte: () => encode(multi("mixed", part("text/plain", "hi"), part("text/html", "<p>", body(full, words)))),
	manyParts: () => encode(multi("mixed", ...Array.from({ length: 12 }, (_, index) => part("text/" + (index % 2 ? "html" : "plain") + "; charset=utf-8", euro, body(2 * MiB, words))))),
};

const out = {};
for (const [name, message] of Object.entries(shapes)) {
	const raw = message();
	const started = performance.now();
	const parsed = await parseRawMime(raw);
	const snippet = buildSnippet(parsed.text, parsed.html);
	out[name] = {
		text: parsed.text?.length ?? 0,
		html: parsed.html?.length ?? 0,
		textNote: parsed.text?.endsWith("download it.]") ?? false,
		htmlNote: parsed.html?.endsWith("download it.</p>") ?? false,
		snippet: snippet.length,
		ms: Math.round(performance.now() - started),
	};
}
console.log(JSON.stringify(out));
`,
);

// Without coverage collection, which every child would inherit and which would have to fit in the same heap.
const childEnv = Object.fromEntries(
	Object.entries(process.env).filter(([name]) => name !== "NODE_V8_COVERAGE" && name !== "NODE_TEST_CONTEXT"),
);

test("24 MB text and HTML bodies, also two bytes per character, are read within a 64 MB heap", () => {
	const output = execFileSync(process.execPath, ["--max-old-space-size=64", worker], {
		encoding: "utf8",
		env: childEnv,
		timeout: 300_000,
	});
	const results = JSON.parse(output);
	assert.equal(Object.keys(results).length, 13);
	for (const [name, result] of Object.entries(results)) {
		assert.ok(result.ms < 60_000, `${name}: ${result.ms} ms`);
		assert.ok(result.text <= 2 * MiB + TEXT_NOTE.length, `${name}: ${result.text} characters of text`);
		assert.ok(result.html <= 8_000_000 + 2 * MiB, `${name}: ${result.html} characters of HTML`);
	}
	for (const [name, result] of Object.entries(results)) {
		if (!name.startsWith("mixedHtml")) assert.equal(result.snippet, 200, name);
	}
	for (const name of ["text", "textSingleByteCharset", "textBase64"]) {
		assert.ok(results[name].text > 2_000_000 && results[name].textNote, name);
	}
	for (const name of ["html", "htmlSingleByteCharset", "htmlBrackets", "htmlAmpersands", "mixedHtml"]) {
		assert.ok(results[name].html > 4_000_000 && results[name].htmlNote, name);
	}
	// Both alternatives cut, each with its own note.
	assert.ok(results.alternative.textNote && results.alternative.htmlNote);
	// Too large to convert once cut, so a text part beside HTML keeps to its own format and the text body is "hi".
	assert.equal(results.mixedHtml.text, 2);
	assert.equal(results.mixedHtmlSingleByte.text, 2);
});

const header = "From: a@example.com\r\nTo: b@example.com\r\nSubject: x\r\nMIME-Version: 1.0\r\n";
const encode = (message) => new TextEncoder().encode(message).buffer;
const single = (type, content) => `${header}Content-Type: ${type}\r\n\r\n${content}`;
const part = (type, content) => `--B\r\nContent-Type: ${type}\r\n\r\n${content}\r\n`;
const multi = (kind, ...parts) =>
	`${header}Content-Type: multipart/${kind}; boundary="B"\r\n\r\n${parts.join("")}--B--\r\n`;

test("a cut keeps whole lines, or else whole UTF-8 characters", () => {
	const bytes = (text) => new TextEncoder().encode(text);
	assert.equal(decodedTextCut(bytes("abc\ndef"), 10), 7);
	assert.equal(decodedTextCut(bytes("abc\ndef"), 6), 4);
	assert.equal(decodedTextCut(bytes("abc\ndef"), 4), 4);
	assert.equal(decodedTextCut(bytes("abc\ndef"), 0), 0);
	// "€" is three bytes: a cut inside it moves back to before it.
	assert.equal(decodedTextCut(bytes("ab€cd"), 3), 2);
	assert.equal(decodedTextCut(bytes("ab€cd"), 4), 2);
	assert.equal(decodedTextCut(bytes("ab€cd"), 5), 5);
	// A line end further back than 64 KiB is not worth what it would leave out.
	const longLine = bytes(`a\n${"б".repeat(40_000)}`);
	assert.equal(decodedTextCut(longLine, 70_001), 70_000);
	assert.equal(decodedTextCut(bytes(`a\n${"б".repeat(30_000)}`), 60_001), 2);
});

test("a body under the limits is read in full, without a note", async () => {
	const text = "x".repeat(2 * MiB - 1);
	const parsed = await parseRawMime(encode(single("text/plain", text)));
	assert.ok(parsed.text.trimEnd() === text, `${parsed.text.length} characters of text`);
	const html = `<p>${"y".repeat(4 * MiB - 8)}</p>`;
	const stored = await parseRawMime(encode(single("text/html", html)));
	assert.ok(stored.html.trim() === html, `${stored.html.length} characters of HTML`);
});

test("text past the limit is cut on a character boundary and stays UTF-8, with a note", async () => {
	// Two-byte characters and no line ends: the cut falls inside one character unless it moves back.
	const parsed = await parseRawMime(encode(single("text/plain; charset=utf-8", "б".repeat(MiB + 10))));
	assert.equal(parsed.text, `${"б".repeat(MiB)}${TEXT_NOTE}`);
	// Without a charset, a part that is not well formed UTF-8 would read as windows-1252.
	const unlabelled = await parseRawMime(encode(single("text/plain", `${"é".repeat(MiB - 1)}x€`)));
	assert.equal(unlabelled.text, `${"é".repeat(MiB - 1)}x${TEXT_NOTE}`);
});

test("HTML past the limit ends with the note, inside the root direction", async () => {
	const line = `<p>${"x".repeat(1_000)}</p>\r\n`;
	const parsed = await parseRawMime(encode(single("text/html", line.repeat(5_000))));
	const kept = Math.floor((4 * MiB) / line.length);
	assert.equal(parsed.html, `${`<p>${"x".repeat(1_000)}</p>\n`.repeat(kept)}${HTML_NOTE}`);
	const rtl = await parseRawMime(encode(single("text/html", `<html dir="rtl"><body>${line.repeat(5_000)}`)));
	assert.ok(rtl.html.startsWith('<div dir="rtl">'));
	assert.ok(rtl.html.endsWith(`${HTML_NOTE}</div>`));
	assert.equal(wrappedRootDirection(rtl.html), "rtl");
});

test("each format has its own limit, and parts past it are left out", async () => {
	const large = `${"x".repeat(1_000)}\r\n`.repeat(2_200);
	// Alternatives: only the cut one gets the note.
	const textCut = await parseRawMime(
		encode(multi("alternative", part("text/plain", large), part("text/html", "<p>hi</p>"))),
	);
	assert.ok(textCut.text.endsWith(TEXT_NOTE));
	assert.equal(textCut.html, "<p>hi</p>");
	const htmlCut = await parseRawMime(
		encode(multi("alternative", part("text/plain", "hi"), part("text/html", large.repeat(2)))),
	);
	assert.equal(htmlCut.text, "hi");
	assert.ok(htmlCut.html.endsWith(HTML_NOTE));
	// A text part after the cut one adds nothing, even when it would fit in what the cut left.
	const twoTexts = await parseRawMime(encode(multi("mixed", part("text/plain", large), part("text/plain", "after"))));
	assert.ok(!twoTexts.text.includes("after"));
	assert.ok(twoTexts.text.endsWith(TEXT_NOTE));
});

test("a cut text part converted into the HTML body puts the note there too", async () => {
	const large = `${"x".repeat(1_000)}\r\n`.repeat(2_200);
	const parsed = await parseRawMime(encode(multi("mixed", part("text/html", "<p>hi</p>"), part("text/plain", large))));
	assert.ok(parsed.text.endsWith(TEXT_NOTE));
	assert.ok(parsed.html.startsWith("<p>hi</p>"));
	assert.ok(parsed.html.endsWith(HTML_NOTE));
});
