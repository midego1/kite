import type { TextPdfBlock, TextPdfDocument, TextPdfResult } from "./text-pdf-types";

/**
 * A small text-only PDF writer: wrapped lines of Helvetica on A4 pages, a few font sizes, grey text, indents and
 * rules. It needs no dependency and no browser, so it runs anywhere, and the text stays selectable and searchable.
 * The standard PDF fonts only cover Windows-1252 (WinAnsi), which holds every Western European language; other
 * characters are reported as `lossy` so the caller can point at Print → Save as PDF for a faithful copy.
 */

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 56;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const LINE_HEIGHT = 1.35;

// Helvetica and Helvetica-Bold advance widths (1/1000 em) for ASCII 32-126, from the Adobe core font metrics.
// prettier-ignore
const HELVETICA = [
	278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
	556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
	667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556,
	556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
// prettier-ignore
const HELVETICA_BOLD = [
	278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
	556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
	667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611,
	611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];
// Widths of the WinAnsi characters above ASCII that differ from the letter they decorate.
const WIDE_SYMBOLS: Record<string, number> = {
	"€": 556,
	"…": 1000,
	"—": 1000,
	"–": 556,
	"•": 350,
	"‘": 222,
	"’": 222,
	"“": 333,
	"”": 333,
	"„": 333,
	"‚": 222,
	"™": 1000,
	"©": 737,
	"®": 737,
	"°": 400,
	"«": 556,
	"»": 556,
	"×": 584,
	"÷": 584,
	" ": 278,
	Æ: 1000,
	æ: 889,
	Œ: 1000,
	œ: 944,
	ß: 611,
};

// Windows-1252 bytes 0x80-0x9F that are not Latin-1 control characters.
const WIN_ANSI_EXTRA: Record<string, number> = {
	"€": 0x80,
	"‚": 0x82,
	ƒ: 0x83,
	"„": 0x84,
	"…": 0x85,
	"†": 0x86,
	"‡": 0x87,
	ˆ: 0x88,
	"‰": 0x89,
	Š: 0x8a,
	"‹": 0x8b,
	Œ: 0x8c,
	Ž: 0x8e,
	"‘": 0x91,
	"’": 0x92,
	"“": 0x93,
	"”": 0x94,
	"•": 0x95,
	"–": 0x96,
	"—": 0x97,
	"˜": 0x98,
	"™": 0x99,
	š: 0x9a,
	"›": 0x9b,
	œ: 0x9c,
	ž: 0x9e,
	Ÿ: 0x9f,
};

// Typography the standard fonts lack, written as the nearest WinAnsi text instead of a question mark.
const SUBSTITUTES: Record<string, string> = {
	"‐": "-",
	"‑": "-",
	"‒": "-",
	"−": "-",
	"′": "'",
	"″": '"',
	"•": "•",
	"‣": "•",
	"●": "•",
	"⁃": "-",
	" ": " ",
	" ": " ",
	" ": " ",
	" ": " ",
	" ": " ",
	" ": " ",
	" ": " ",
	"→": "->",
	"←": "<-",
	"≤": "<=",
	"≥": ">=",
	"≠": "!=",
	Ł: "L",
	ł: "l",
	Đ: "D",
	đ: "d",
	ı: "i",
};

// Invisible characters that carry no text of their own: zero-width spaces and joiners, the BOM, variation selectors.
const INVISIBLE = /[​-‍⁠﻿︀-️]/u;
const PICTOGRAPHIC = /\p{Extended_Pictographic}|[\u{1f1e6}-\u{1f1ff}\u{1f3fb}-\u{1f3ff}]/u;

/** The Windows-1252 byte for one character, or null when the standard fonts cannot show it. */
function winAnsiByte(char: string): number | null {
	const code = char.codePointAt(0) ?? 0;
	if (code >= 0x20 && code <= 0x7e) return code;
	if (code >= 0xa0 && code <= 0xff) return code;
	return WIN_ANSI_EXTRA[char] ?? null;
}

/**
 * Text as WinAnsi characters (each one a byte, kept as a one-byte string for the writer). A character outside it is
 * replaced by its nearest typographic stand-in, its unaccented letter, nothing (emoji and invisible characters) or
 * `?`, and counted in `lost`. Tabs become spaces; other control characters are dropped.
 * @public Exercised by the unit tests.
 */
export function toWinAnsi(text: string): { text: string; lost: number } {
	let out = "";
	let lost = 0;
	for (const char of text) {
		if (char === "\t") {
			out += "    ";
			continue;
		}
		if (winAnsiByte(char) !== null) {
			out += String.fromCharCode(winAnsiByte(char)!);
			continue;
		}
		if ((char.codePointAt(0) ?? 0) < 0x20 || INVISIBLE.test(char)) continue;
		const substitute = SUBSTITUTES[char] ?? stripAccents(char);
		if (substitute !== null && [...substitute].every((part) => winAnsiByte(part) !== null)) {
			out += [...substitute].map((part) => String.fromCharCode(winAnsiByte(part)!)).join("");
			// A stand-in from the table reads the same; a letter without its accent does not.
			if (!SUBSTITUTES[char]) lost += 1;
			continue;
		}
		lost += 1;
		if (!PICTOGRAPHIC.test(char)) out += "?";
	}
	return { text: out, lost };
}

function stripAccents(char: string): string | null {
	const base = char.normalize("NFKD").replace(/\p{M}/gu, "");
	return base && base !== char ? base : null;
}

/** The decorated letter a WinAnsi accented character is drawn on, for its width. */
function baseLetter(char: string): string {
	return char.normalize("NFD").charAt(0);
}

/** The width of WinAnsi text (as `toWinAnsi` returns it) in points at `size`.
 * @public Exercised by the unit tests.
 */
export function measureText(text: string, size: number, bold = false): number {
	const widths = bold ? HELVETICA_BOLD : HELVETICA;
	let total = 0;
	for (const byte of text) {
		const char = byte.charCodeAt(0) < 0x80 ? byte : decodeWinAnsi(byte);
		const ascii = char.charCodeAt(0);
		if (ascii >= 0x20 && ascii <= 0x7e) total += widths[ascii - 0x20];
		else if (char in WIDE_SYMBOLS) total += WIDE_SYMBOLS[char];
		else {
			const base = baseLetter(char).charCodeAt(0);
			total += base >= 0x20 && base <= 0x7e ? widths[base - 0x20] : 556;
		}
	}
	return (total * size) / 1000;
}

const WIN_ANSI_DECODE = new Map(Object.entries(WIN_ANSI_EXTRA).map(([char, byte]) => [byte, char]));

function decodeWinAnsi(byte: string): string {
	const code = byte.charCodeAt(0);
	return WIN_ANSI_DECODE.get(code) ?? byte;
}

/**
 * Breaks WinAnsi text into lines no wider than `width`, at spaces where it can and inside a word only when the
 * word alone is too wide (a long link). Explicit line breaks are kept; an empty input is one empty line.
 * @public Exercised by the unit tests.
 */
export function wrapText(text: string, width: number, size: number, bold = false): string[] {
	const lines: string[] = [];
	for (const paragraph of text.split("\n")) {
		const first = lines.length;
		let line = "";
		for (const word of paragraph.split(/(?<= )/)) {
			const candidate = line + word;
			if (measureText(candidate.trimEnd(), size, bold) <= width) {
				line = candidate;
				continue;
			}
			if (line) lines.push(line.trimEnd());
			line = "";
			let rest = word;
			while (measureText(rest.trimEnd(), size, bold) > width) {
				let cut = 1;
				while (cut < rest.length && measureText(rest.slice(0, cut + 1), size, bold) <= width) cut += 1;
				lines.push(rest.slice(0, cut));
				rest = rest.slice(cut);
			}
			line = rest;
		}
		// A paragraph whose last word was split ends with that word's last piece, not an empty line.
		if (line.trimEnd() || lines.length === first) lines.push(line.trimEnd());
	}
	return lines;
}

/** A PDF literal string: `(`, `)` and `\` escaped, bytes above ASCII written as octal escapes.
 * @public Exercised by the unit tests.
 */
export function pdfString(text: string): string {
	let out = "(";
	for (const byte of text) {
		const code = byte.charCodeAt(0);
		if (byte === "(" || byte === ")" || byte === "\\") out += `\\${byte}`;
		else if (code < 0x20 || code > 0x7e) out += `\\${code.toString(8).padStart(3, "0")}`;
		else out += byte;
	}
	return `${out})`;
}

/** Any text as a UTF-16BE hex string, which PDF metadata (the document title) reads as Unicode.
 * @public Exercised by the unit tests.
 */
export function pdfUnicodeString(text: string): string {
	let hex = "FEFF";
	for (let index = 0; index < text.length; index += 1)
		hex += text.charCodeAt(index).toString(16).padStart(4, "0").toUpperCase();
	return `<${hex}>`;
}

const number = (value: number) => (Math.round(value * 100) / 100).toString();

type PageWriter = { pages: string[][]; y: number };

function newPage(writer: PageWriter) {
	writer.pages.push([]);
	writer.y = PAGE_HEIGHT - MARGIN;
}

function ensureSpace(writer: PageWriter, height: number) {
	if (writer.y - height < MARGIN) newPage(writer);
}

function drawBlock(writer: PageWriter, block: TextPdfBlock): number {
	const size = block.size ?? 10.5;
	const lineHeight = size * LINE_HEIGHT;
	const indent = block.indent ?? 0;
	if (block.spaceBefore && writer.y < PAGE_HEIGHT - MARGIN) writer.y -= block.spaceBefore;
	if (block.rule) {
		ensureSpace(writer, 1);
		const y = number(writer.y);
		writer.pages.at(-1)!.push(`0.8 G 0.5 w ${number(MARGIN)} ${y} m ${number(PAGE_WIDTH - MARGIN)} ${y} l S`);
		writer.y -= 1;
		return 0;
	}
	const { text, lost } = toWinAnsi(block.text ?? "");
	const font = block.bold ? "F2" : "F1";
	const grey = number(block.grey ?? 0);
	for (const line of wrapText(text, CONTENT_WIDTH - indent, size, block.bold)) {
		ensureSpace(writer, lineHeight);
		writer.y -= lineHeight;
		if (!line) continue;
		const x = number(MARGIN + indent);
		// The baseline sits a fifth of the line above its bottom, so descenders stay inside the line.
		const y = number(writer.y + (lineHeight - size) / 2 + size * 0.2);
		writer.pages.at(-1)!.push(`BT /${font} ${number(size)} Tf ${grey} g ${x} ${y} Td ${pdfString(line)} Tj ET`);
	}
	return lost;
}

/**
 * Lays out `document.blocks` on A4 pages and returns the PDF file. Every object offset is counted in bytes, so the
 * text is kept as one-byte characters until the end.
 */
export function buildTextPdf(document: TextPdfDocument): TextPdfResult {
	const writer: PageWriter = { pages: [], y: 0 };
	newPage(writer);
	let lost = 0;
	for (const block of document.blocks) lost += drawBlock(writer, block);

	const objects: string[] = [];
	const pageCount = writer.pages.length;
	// 1 catalog, 2 pages, 3 info, 4-5 fonts, then a page and its content stream per page.
	const pageId = (index: number) => 6 + index * 2;
	objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
	objects[2] = `<< /Type /Pages /Count ${pageCount} /Kids [${writer.pages.map((_, index) => `${pageId(index)} 0 R`).join(" ")}] >>`;
	objects[3] = `<< /Title ${pdfUnicodeString(document.title)} /Producer (Kite) >>`;
	objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
	objects[5] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
	writer.pages.forEach((commands, index) => {
		const stream = commands.join("\n");
		objects[pageId(index)] =
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
			`/Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents ${pageId(index) + 1} 0 R >>`;
		objects[pageId(index) + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
	});

	let out = "%PDF-1.4\n%âãÏÓ\n";
	const offsets: number[] = [];
	for (let id = 1; id < objects.length; id += 1) {
		offsets[id] = out.length;
		out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
	}
	const xref = out.length;
	out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
	for (let id = 1; id < objects.length; id += 1) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
	out += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

	const bytes = new Uint8Array(out.length);
	for (let index = 0; index < out.length; index += 1) bytes[index] = out.charCodeAt(index);
	return { bytes, pages: pageCount, lost };
}
