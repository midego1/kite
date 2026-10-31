// Synthetic MIME messages for tests/mime-index.test.mjs: example.com only, no real people or mail.
// Each fixture is { name, raw, expected }, where `expected` lists, per postal-mime attachment in order, whether the
// index must match it ("match"), must not ("unmatched"), or may do either ("either"; the byte check decides).
// postal-mime 2.7 hands 7bit and 8bit bodies back with LF line breaks and a final LF, so those rarely match and are
// stored as objects, as before.

/** Deterministic bytes, so fixtures are stable between runs. */
export function pseudoRandomBytes(length, seed = 1) {
	const bytes = new Uint8Array(length);
	let state = seed >>> 0 || 1;
	for (let index = 0; index < length; index++) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		bytes[index] = state & 0xff;
	}
	return bytes;
}

function wrap(text, width, eol) {
	if (!width) return text;
	const lines = [];
	for (let index = 0; index < text.length; index += width) lines.push(text.slice(index, index + width));
	return lines.join(eol);
}

export function base64(bytes, { width = 76, eol = "\r\n", trailing = "" } = {}) {
	const encoded = Buffer.from(bytes).toString("base64");
	return wrap(encoded, width, `${trailing}${eol}`);
}

function quotedPrintable(text) {
	return text.replace(/=/g, "=3D").replace(/é/g, "=C3=A9");
}

function uuencode(bytes) {
	const lines = ["begin 644 data.bin"];
	for (let index = 0; index < bytes.length; index += 45) {
		const chunk = bytes.subarray(index, index + 45);
		let line = String.fromCharCode(32 + chunk.length);
		for (let at = 0; at < chunk.length; at += 3) {
			const [a = 0, b = 0, c = 0] = chunk.subarray(at, at + 3);
			const values = [a >> 2, ((a & 3) << 4) | (b >> 4), ((b & 15) << 2) | (c >> 6), c & 63];
			line += values.map((value) => String.fromCharCode(value === 0 ? 96 : value + 32)).join("");
		}
		lines.push(line);
	}
	lines.push("`", "end");
	return lines.join("\r\n");
}

const PDF = pseudoRandomBytes(5000, 7);
const PNG = pseudoRandomBytes(1200, 11);
const ZIP = pseudoRandomBytes(3333, 13);

function headers(extra = []) {
	return [
		"From: Sender <sender@example.com>",
		"To: Reader <reader@example.com>",
		"Subject: Fixture",
		"Date: Fri, 30 Oct 2026 10:00:00 +0000",
		"Message-ID: <fixture@example.com>",
		"MIME-Version: 1.0",
		...extra,
	];
}

function lines(list, eol = "\r\n") {
	return list.join(eol);
}

function textPart(boundary, text = "Hello from example.com.") {
	return [`--${boundary}`, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 7bit", "", text];
}

function base64Part(boundary, { type, name, bytes, disposition = "attachment", options, extra = [] }) {
	return [
		`--${boundary}`,
		`Content-Type: ${type}; name="${name}"`,
		`Content-Disposition: ${disposition}; filename="${name}"`,
		"Content-Transfer-Encoding: base64",
		...extra,
		"",
		base64(bytes, options),
	];
}

function mixed({ boundary = "mix-1", parts, eol = "\r\n", preamble = [], epilogue = [], close = true, type }) {
	return lines(
		[
			...headers([type ?? `Content-Type: multipart/mixed; boundary="${boundary}"`]),
			"",
			...preamble,
			...parts.flat(),
			...(close ? [`--${boundary}--`] : []),
			...epilogue,
		],
		eol,
	);
}

const pdf = (boundary, options) =>
	base64Part(boundary, { type: "application/pdf", name: "report.pdf", bytes: PDF, options });

export const FIXTURES = [
	{
		name: "multipart/mixed",
		raw: mixed({ parts: [textPart("mix-1"), pdf("mix-1")] }),
		expected: ["match"],
	},
	{
		name: "related inside alternative inside mixed, with an inline cid image",
		raw: lines([
			...headers(['Content-Type: multipart/mixed; boundary="outer"']),
			"",
			"--outer",
			'Content-Type: multipart/alternative; boundary="alt"',
			"",
			...textPart("alt"),
			"--alt",
			'Content-Type: multipart/related; boundary="rel"',
			"",
			"--rel",
			"Content-Type: text/html; charset=utf-8",
			"",
			'<p>Logo: <img src="cid:logo@example.com"></p>',
			...base64Part("rel", {
				type: "image/png",
				name: "logo.png",
				bytes: PNG,
				disposition: "inline",
				extra: ["Content-ID: <logo@example.com>"],
			}),
			"--rel--",
			"--alt--",
			...pdf("outer"),
			"--outer--",
			"",
		]),
		expected: ["match", "match"],
	},
	{
		name: "LF-only line endings",
		raw: mixed({ parts: [textPart("mix-1"), pdf("mix-1", { eol: "\n" })], eol: "\n" }),
		expected: ["match"],
	},
	{
		name: "base64 without line breaks",
		raw: mixed({ parts: [textPart("mix-1"), pdf("mix-1", { width: 0 })] }),
		expected: ["match"],
	},
	{
		name: "base64 with 64-column lines",
		raw: mixed({ parts: [textPart("mix-1"), pdf("mix-1", { width: 64 })] }),
		expected: ["match"],
	},
	{
		name: "base64 with 72-column lines and trailing spaces",
		raw: mixed({ parts: [textPart("mix-1"), pdf("mix-1", { width: 72, trailing: "  " })] }),
		expected: ["match"],
	},
	{
		name: "quoted boundary with spaces and punctuation",
		raw: mixed({
			boundary: "a b:c=d",
			parts: [textPart("a b:c=d"), pdf("a b:c=d")],
		}),
		expected: ["match"],
	},
	{
		name: "folded Content-Type headers",
		raw: lines([
			...headers(["Content-Type: multipart/mixed;", '\tboundary="folded"']),
			"",
			...textPart("folded"),
			"--folded",
			"Content-Type: application/pdf;",
			' name="report.pdf"',
			"Content-Disposition: attachment;",
			'  filename="report.pdf"',
			"Content-Transfer-Encoding:",
			" base64",
			"",
			base64(PDF),
			"--folded--",
		]),
		expected: ["match"],
	},
	{
		name: "a preamble and an epilogue",
		raw: mixed({
			parts: [textPart("mix-1"), pdf("mix-1")],
			preamble: ["This is a multi-part message in MIME format.", ""],
			epilogue: ["", "Epilogue text that is not a part."],
		}),
		expected: ["match"],
	},
	{
		name: "a missing close delimiter",
		raw: `${mixed({ parts: [textPart("mix-1"), pdf("mix-1")], close: false })}\r\n`,
		expected: ["match"],
	},
	{
		name: "two identical attachments",
		raw: mixed({ parts: [textPart("mix-1"), pdf("mix-1"), pdf("mix-1")] }),
		expected: ["match", "match"],
	},
	{
		name: "a message/rfc822 attached as a file",
		raw: mixed({
			parts: [
				textPart("mix-1"),
				[
					"--mix-1",
					"Content-Type: message/rfc822",
					'Content-Disposition: attachment; filename="forwarded.eml"',
					"",
					...headers(['Content-Type: multipart/mixed; boundary="inner"']),
					"",
					...textPart("inner", "Inner message."),
					...base64Part("inner", { type: "application/zip", name: "inner.zip", bytes: ZIP }),
					"--inner--",
				],
			],
		}),
		expected: ["either"],
	},
	{
		name: "a 7bit text attachment, LF-only",
		raw: mixed({
			eol: "\n",
			parts: [
				textPart("mix-1"),
				[
					"--mix-1",
					'Content-Type: text/plain; name="notes.txt"',
					'Content-Disposition: attachment; filename="notes.txt"',
					"Content-Transfer-Encoding: 7bit",
					"",
					"line one",
					"line two",
				],
			],
		}),
		expected: ["either"],
	},
	{
		name: "a 7bit text attachment, CRLF",
		raw: mixed({
			parts: [
				textPart("mix-1"),
				[
					"--mix-1",
					'Content-Type: text/plain; name="notes.txt"',
					'Content-Disposition: attachment; filename="notes.txt"',
					"",
					"line one",
					"line two",
				],
			],
		}),
		expected: ["either"],
	},
	{
		name: "quoted-printable and uuencode attachments",
		raw: mixed({
			parts: [
				textPart("mix-1"),
				[
					"--mix-1",
					'Content-Type: text/plain; charset=utf-8; name="qp.txt"',
					'Content-Disposition: attachment; filename="qp.txt"',
					"Content-Transfer-Encoding: quoted-printable",
					"",
					quotedPrintable("café = coffee"),
				],
				[
					"--mix-1",
					'Content-Type: application/octet-stream; name="data.bin"',
					'Content-Disposition: attachment; filename="data.bin"',
					"Content-Transfer-Encoding: x-uuencode",
					"",
					uuencode(ZIP.subarray(0, 200)),
				],
			],
		}),
		expected: ["unmatched", "unmatched"],
	},
	{
		name: "an attachment as the whole message",
		raw: lines([
			...headers([
				'Content-Type: application/pdf; name="report.pdf"',
				'Content-Disposition: attachment; filename="report.pdf"',
				"Content-Transfer-Encoding: base64",
			]),
			"",
			base64(PDF),
			"",
		]),
		expected: ["match"],
	},
	{
		name: "RFC 2231 file names",
		raw: mixed({
			parts: [
				textPart("mix-1"),
				[
					"--mix-1",
					"Content-Type: application/pdf",
					"Content-Disposition: attachment; filename*0*=utf-8''r%C3%A9; filename*1=port.pdf",
					"Content-Transfer-Encoding: base64",
					"",
					base64(PDF),
				],
			],
		}),
		expected: ["match"],
	},
];

/** A message of about `size` bytes carrying one base64 attachment of most of it. */
export function largeFixture(size) {
	const bytes = pseudoRandomBytes(Math.floor(((size - 2048) * 3) / 4 / 1.027), 23);
	return {
		bytes,
		raw: mixed({
			parts: [textPart("mix-1"), base64Part("mix-1", { type: "application/octet-stream", name: "big.bin", bytes })],
		}),
	};
}
