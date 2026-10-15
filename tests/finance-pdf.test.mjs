import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { loadFinance } from "./support/finance-bundle.mjs";

const pdf = await loadFinance("pdf-text-utils");

const MIB = 1_048_576;

/** A small synthetic PDF: one object per stream, raw or Flate-compressed, with an optional extra trailer. */
function makePdf(streams, { trailer = "", header = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n" } = {}) {
	const parts = [Buffer.from(header, "latin1")];
	streams.forEach((stream, index) => {
		const flate = stream.flate ?? false;
		const body = Buffer.isBuffer(stream.data) ? stream.data : Buffer.from(stream.data, "latin1");
		const data = flate ? deflateSync(body) : body;
		const dict = stream.dict ?? (flate ? "/Filter /FlateDecode" : "");
		parts.push(
			Buffer.from(`${index + 4} 0 obj\n<< /Length ${data.length} ${dict} >>\nstream\n`, "latin1"),
			data,
			Buffer.from("\nendstream\nendobj\n", "latin1"),
		);
	});
	parts.push(Buffer.from(`trailer\n<< /Root 1 0 R ${trailer}>>\n%%EOF\n`, "latin1"));
	return Buffer.concat(parts);
}

const base64 = (bytes) => ({ encoding: "base64", content: bytes.toString("base64"), truncated: false });
const textOf = (bytes, options) => pdf.pdfTextFromContent(base64(bytes), options);

const INVOICE = "BT /F1 12 Tf 72 720 Td (Streamflix invoice INV-7) Tj 0 -16 Td ($12.00 per month) Tj ET";

test("reads Tj text from a plain PDF", async () => {
	const text = await textOf(makePdf([{ data: INVOICE }]));
	assert.match(text, /Streamflix invoice INV-7\n\$12\.00 per month/);
});

test("reads Tj text from a FlateDecode PDF, in either filter spelling", async () => {
	assert.match(await textOf(makePdf([{ data: INVOICE, flate: true }])), /\$12\.00 per month/);
	const array = makePdf([{ data: INVOICE, flate: true, dict: "/Filter [ /FlateDecode ]" }]);
	assert.match(await textOf(array), /\$12\.00 per month/);
});

test("reads TJ arrays, quote operators, hex strings, escapes and UTF-16", async () => {
	const content = [
		"BT [(Total) -250 (due:) 120 ( \\(EUR\\))] TJ",
		"(line\\040two\\nthree) '",
		'1 2 (spaced\\\nword) "',
		"<0024 31322E3030> Tj",
		"<FEFF00A3003500200061> Tj",
		"(\\376\\377\\000Z) Tj",
		"(\\200 9,99 \\226 \\x) Tj",
		"(open (nested) end) Tj",
		"% a comment (not text) Tj",
		"<< /MCID 0 >> BDC (marked) Tj EMC",
		"T* (after) Tj ET",
	].join("\n");
	const text = await textOf(makePdf([{ data: content }]));
	assert.match(text, /Total due: \(EUR\)/);
	assert.match(text, /\nline two\nthree/);
	assert.match(text, /\nspacedword/);
	assert.match(text, /\$12\.00/);
	assert.match(text, /£5 a/);
	assert.match(text, /Z/);
	assert.match(text, /€ 9,99 – x/);
	assert.match(text, /open \(nested\) end/);
	assert.doesNotMatch(text, /comment/);
	assert.match(text, /marked/);
	assert.match(text, /\nafter/);
});

test("an operand that no text operator uses is dropped", async () => {
	const text = await textOf(makePdf([{ data: "BT (kept) Tj (unused) 3 w ET" }]));
	assert.match(text, /kept/);
	assert.doesNotMatch(text, /unused/);
});

test("encrypted PDFs are skipped", async () => {
	const bytes = makePdf([{ data: INVOICE }], { trailer: "/Encrypt 9 0 R " });
	assert.equal(await textOf(bytes), null);
});

test("truncated reads, text content, missing content and non-PDF bytes are skipped", async () => {
	const bytes = makePdf([{ data: INVOICE }]);
	assert.equal(await pdf.pdfTextFromContent({ ...base64(bytes), truncated: true }), null);
	assert.equal(await pdf.pdfTextFromContent({ encoding: "text", content: "%PDF-1.4", truncated: false }), null);
	assert.equal(await pdf.pdfTextFromContent(null), null);
	assert.equal(await textOf(Buffer.from("GIF89a not a pdf")), null);
	assert.equal(await pdf.pdfTextFromContent({ encoding: "base64", content: "%%%", truncated: false }), null);
});

test("a stream cut off before endstream ends the walk with what was read", async () => {
	const whole = makePdf([{ data: "BT (first) Tj ET" }, { data: "BT (second) Tj ET" }]);
	const cut = whole.subarray(0, whole.indexOf("second") + 3);
	const text = await textOf(cut);
	assert.match(text, /first/);
	assert.doesNotMatch(text, /second/);
});

test("walks at most 32 streams", async () => {
	const streams = Array.from({ length: 40 }, (_, index) => ({ data: `BT (s${index}x) Tj ET` }));
	const text = await textOf(makePdf(streams));
	assert.match(text, /s31x/);
	assert.doesNotMatch(text, /s32x/);
	assert.equal(pdf.PDF_LIMITS.maxStreams, 32);
});

test("images, fonts and other filters are not decoded", async () => {
	const text = await textOf(
		makePdf([
			{ data: "BT (image) Tj ET", flate: true, dict: "/Subtype /Image /Filter /FlateDecode" },
			{ data: "BT (font) Tj ET", flate: true, dict: "/Length1 20 /Filter /FlateDecode" },
			{ data: "BT (jpeg) Tj ET", dict: "/Filter /DCTDecode" },
			{ data: "BT (chain) Tj ET", dict: "/Filter [/FlateDecode /ASCIIHexDecode]" },
			{ data: "BT (content) Tj ET" },
		]),
	);
	assert.equal(text.trim(), "content");
});

test("inflate stops at 1 MiB per stream and 4 MiB in total", async () => {
	assert.equal(pdf.PDF_LIMITS.maxStreamBytes, MIB);
	assert.equal(pdf.PDF_LIMITS.maxInflatedBytes, 4 * MIB);
	// A decompression bomb: 3 MiB of padding before the text inflates to only the first MiB.
	const bomb = Buffer.concat([Buffer.alloc(3 * MIB, 0x20), Buffer.from("BT (hidden) Tj ET")]);
	const early = "BT (early) Tj ET";
	const one = await textOf(
		makePdf([
			{ data: early, flate: true },
			{ data: bomb, flate: true },
		]),
	);
	assert.match(one, /early/);
	assert.doesNotMatch(one, /hidden/);
	// Each padded stream uses its full MiB, so the fifth one gets no budget left.
	const padded = (label) => Buffer.concat([Buffer.from(`BT (${label}) Tj ET `), Buffer.alloc(2 * MIB, 0x20)]);
	const streams = ["p1", "p2", "p3", "p4", "p5"].map((label) => ({ data: padded(label), flate: true }));
	const many = await textOf(makePdf(streams));
	assert.match(many, /p4/);
	assert.doesNotMatch(many, /p5/);
	// Smaller caps apply the same way.
	const capped = await textOf(makePdf([{ data: INVOICE, flate: true }]), { limits: { maxStreamBytes: 10 } });
	assert.doesNotMatch(capped ?? "", /per month/);
});

test("corrupt Flate data yields no text and no error", async () => {
	const text = await textOf(makePdf([{ data: Buffer.from("not deflate at all"), dict: "/Filter /FlateDecode" }]));
	assert.equal(text, "");
});

test("text stops at 64 KB", async () => {
	assert.equal(pdf.PDF_LIMITS.maxTextChars, 65_536);
	const long = Array.from({ length: 2000 }, (_, index) => `(${"w".repeat(60)}${index}) Tj`).join(" T* ");
	const text = await textOf(makePdf([{ data: `BT ${long} ET` }]));
	assert.equal(text.length, 65_536);
	const small = await textOf(makePdf([{ data: INVOICE }]), { limits: { maxTextChars: 9 } });
	assert.equal(small, "Streamfli");
});

test("stops by itself after 5 seconds and returns what it has", async () => {
	assert.equal(pdf.PDF_LIMITS.maxMs, 5_000);
	let clock = 0;
	const now = () => {
		clock += 2_000;
		return clock;
	};
	const streams = ["a1", "a2", "a3", "a4", "a5"].map((label) => ({ data: `BT (${label}) Tj ET` }));
	const text = await textOf(makePdf(streams), { now });
	assert.match(text, /a1/);
	assert.doesNotMatch(text, /a5/);
});

const attachment = (overrides = {}) => ({
	id: "att-1",
	contentType: "application/pdf",
	filename: "invoice-7.pdf",
	size: 4000,
	...overrides,
});

test("pdfToRead picks the document PDF only when the body has no amount and a keyword matched", () => {
	const keyword = { amount: null, signals: new Set(["subject_keyword"]) };
	assert.equal(pdf.pdfToRead(keyword, [attachment()])?.id, "att-1");
	assert.equal(pdf.pdfToRead({ amount: null, signals: new Set(["invoice_attachment"]) }, [attachment()])?.id, "att-1");
	assert.equal(
		pdf.pdfToRead({ amount: { minor: 1, currency: "USD" }, signals: keyword.signals }, [attachment()]),
		null,
	);
	assert.equal(pdf.pdfToRead({ amount: null, signals: new Set() }, [attachment()]), null);
	assert.equal(pdf.pdfToRead(keyword, [attachment({ contentType: "image/png", filename: "invoice.png" })]), null);
	assert.equal(pdf.pdfToRead(keyword, [attachment({ size: pdf.PDF_READ_MAX_BYTES + 1 })]), null);
	assert.equal(pdf.pdfToRead(keyword, []), null);
	const lone = attachment({ filename: "statement.pdf" });
	assert.equal(pdf.pdfToRead(keyword, [lone])?.id, "att-1");
	assert.equal(pdf.PDF_READ_MAX_BYTES, 2_097_152);
});

test("withPdfText appends the PDF text to the excerpt and leaves the input alone without it", () => {
	const input = { message: { id: "m", textExcerpt: "Your invoice is attached." }, attachments: [] };
	assert.equal(pdf.withPdfText(input, null), input);
	assert.equal(pdf.withPdfText(input, "  "), input);
	const joined = pdf.withPdfText(input, "$12.00 per month");
	assert.equal(joined.message.textExcerpt, "Your invoice is attached.\n$12.00 per month");
	assert.equal(input.message.textExcerpt, "Your invoice is attached.");
	assert.equal(pdf.withPdfText({ ...input, message: { id: "m", textExcerpt: null } }, "x").message.textExcerpt, "x");
});
