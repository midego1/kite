import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

const {
	buildMimeMessage,
	mintMessageId,
	normalizeMessageId,
	formatMailDate,
	foldHeader,
	encodedWords,
	textTokens,
	addressTokens,
	mediaType,
	parameterTokens,
	encodeQuotedPrintable,
	encodeBase64Lines,
	parseRawMime,
} = await bundleModules("kite-mime-build-", [
	[
		"buildMimeMessage, mintMessageId, normalizeMessageId, formatMailDate, foldHeader, encodedWords, textTokens, addressTokens, mediaType, parameterTokens, encodeQuotedPrintable, encodeBase64Lines",
		"src/lib/email/mime-build-utils.ts",
	],
	["parseRawMime", "src/lib/email/parse.ts"],
]);

const DATE = new Date("2026-10-29T09:05:03Z");
const FROM = "Kite User <user@example.test>";
const decode = (raw) => new TextDecoder().decode(raw);
const toArrayBuffer = (raw) => raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
const parse = (built) => parseRawMime(toArrayBuffer(built.raw));
const bytes = (value) => new TextEncoder().encode(value);

/** Counting random bytes, so boundaries are predictable and still differ per multipart. */
function counter() {
	let next = 0;
	return (length) => Uint8Array.from({ length }, () => next++ % 256);
}

function build(message, options = {}) {
	return buildMimeMessage(
		{ from: FROM, to: ["friend@example.org"], subject: "Hello", ...message },
		{ date: DATE, messageId: "<test-1@example.test>", ...options },
	);
}

/** The header block of a message (or part), unfolded, as name → values. */
function headers(raw) {
	const head = decode(raw)
		.split("\r\n\r\n")[0]
		.replace(/\r\n[ \t]/g, " ");
	const map = new Map();
	for (const line of head.split("\r\n")) {
		const index = line.indexOf(":");
		const name = line.slice(0, index).toLowerCase();
		map.set(name, [...(map.get(name) ?? []), line.slice(index + 1).trim()]);
	}
	return map;
}

/** Decodes RFC 2047 B words the strict way: every word must be valid UTF-8 on its own. */
function decodeWords(value) {
	return value
		.replace(/\?=\s+=\?/g, "?==?")
		.replace(/=\?UTF-8\?B\?([^?]*)\?=/g, (_, data) =>
			new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(data, "base64")),
		);
}

function decodeQuotedPrintable(value) {
	const softless = value.replace(/=\r\n/g, "");
	const out = [];
	for (let index = 0; index < softless.length; index += 1) {
		if (softless[index] === "=") {
			out.push(parseInt(softless.slice(index + 1, index + 3), 16));
			index += 2;
		} else out.push(softless.charCodeAt(index));
	}
	return new TextDecoder().decode(Uint8Array.from(out));
}

function assertWellFormed(raw) {
	const text = decode(raw);
	assert.ok(/^[\x00-\x7f]*$/.test(text), "only 7-bit bytes");
	assert.ok(!/\r(?!\n)|(?<!\r)\n/.test(text), "only CRLF line endings");
	for (const line of text.split("\r\n")) assert.ok(line.length <= 998, "no line over 998");
	const head = text.split("\r\n\r\n")[0];
	for (const line of head.split("\r\n")) assert.ok(line.length <= 78, `header line over 78: ${line}`);
	assert.ok(text.endsWith("\r\n"), "ends with CRLF");
}

test("a text-only message is one 7bit part with the standard headers in order", () => {
	const built = build({ text: "Hi there.\nSecond line." });
	assert.equal(
		decode(built.raw),
		[
			"From: Kite User <user@example.test>",
			"To: friend@example.org",
			"Subject: Hello",
			"Date: Thu, 29 Oct 2026 09:05:03 +0000",
			"Message-ID: <test-1@example.test>",
			"MIME-Version: 1.0",
			"Content-Type: text/plain; charset=utf-8",
			"Content-Transfer-Encoding: 7bit",
			"",
			"Hi there.",
			"Second line.",
			"",
		].join("\r\n"),
	);
	assert.equal(built.messageId, "<test-1@example.test>");
	assertWellFormed(built.raw);
});

test("text and HTML become multipart/alternative, text first, and parse back", async () => {
	const built = build(
		{ text: "Plain ✓", html: "<p>Rich ✓</p>", cc: ["Another <another@example.org>", "third@example.org"] },
		{ randomBytes: counter() },
	);
	const raw = decode(built.raw);
	assert.match(raw, /Content-Type: multipart\/alternative;\r\n boundary="=_kite_000102030405060708090a0b"\r\n/);
	assert.ok(raw.indexOf("text/plain") < raw.indexOf("text/html"));
	assert.match(raw, /\r\n--=_kite_000102030405060708090a0b--\r\n$/);
	assertWellFormed(built.raw);
	const parsed = await parse(built);
	assert.equal(parsed.text.trimEnd(), "Plain ✓");
	assert.match(parsed.html, /<p>Rich ✓<\/p>/);
	assert.equal(parsed.subject, "Hello");
	assert.equal(parsed.messageId, "<test-1@example.test>");
	assert.match(parsed.ccAddr, /another@example\.org.*third@example\.org/);
	assert.deepEqual(parsed.attachments, []);
	assert.equal(parsed.date.toISOString(), DATE.toISOString());
});

test("HTML only is a single HTML part; nothing at all is an empty text part", async () => {
	const html = build({ html: "<p>Only HTML</p>" });
	assert.match(decode(html.raw), /^Content-Type: text\/html; charset=utf-8$/m);
	assert.doesNotMatch(decode(html.raw), /multipart/);
	const empty = build({});
	assert.match(
		decode(empty.raw),
		/Content-Type: text\/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n\r\n$/,
	);
	assertWellFormed(empty.raw);
});

test("attachments make multipart/mixed around the alternative, and inline images multipart/related", async () => {
	const image = Uint8Array.from({ length: 300 }, (_, index) => (index * 7) % 256);
	const document = bytes("%PDF-1.4 fake document");
	const built = build(
		{
			text: "See attached",
			html: '<p>See <img src="cid:logo@kite"></p>',
			attachments: [
				{
					filename: "logo.png",
					type: "image/png",
					content: image.buffer,
					disposition: "inline",
					contentId: "<logo@kite>",
				},
				{
					filename: "report.pdf",
					type: "application/pdf; name=x",
					content: document.buffer,
					disposition: "attachment",
				},
			],
		},
		{ randomBytes: counter() },
	);
	const raw = decode(built.raw);
	const types = [...raw.matchAll(/^Content-Type: ([^;\r\n]+)/gm)].map((match) => match[1]);
	assert.deepEqual(types, [
		"multipart/mixed",
		"multipart/alternative",
		"text/plain",
		"multipart/related",
		"text/html",
		"image/png",
		"application/pdf",
	]);
	assert.match(raw, /Content-Disposition: inline; filename="logo.png"\r\nContent-ID: <logo@kite>\r\n/);
	assert.match(raw, /Content-Type: application\/pdf; name="report.pdf"\r\n/);
	// Every multipart has its own boundary.
	assert.equal(new Set([...raw.matchAll(/boundary="([^"]+)"/g)].map((match) => match[1])).size, 3);
	assertWellFormed(built.raw);
	const parsed = await parse(built);
	assert.equal(parsed.text.trimEnd(), "See attached");
	const logo = parsed.attachments.find((attachment) => attachment.filename === "logo.png");
	assert.equal(logo.disposition, "inline");
	assert.equal(logo.contentId, "<logo@kite>");
	assert.deepEqual(new Uint8Array(logo.content), image);
	const pdf = parsed.attachments.find((attachment) => attachment.filename === "report.pdf");
	assert.equal(pdf.type, "application/pdf");
	assert.equal(decode(new Uint8Array(pdf.content)), "%PDF-1.4 fake document");
});

test("inline attachments without HTML or without a usable Content-ID are plain attachments", () => {
	const image = { filename: "a.png", type: "image/png", content: new ArrayBuffer(3), disposition: "inline" };
	const noHtml = decode(build({ text: "x", attachments: [{ ...image, contentId: "a@kite" }] }).raw);
	assert.doesNotMatch(noHtml, /multipart\/related|Content-ID/);
	assert.match(noHtml, /Content-Disposition: attachment; filename="a.png"/);
	for (const contentId of [null, "", "bad id", "a<b"]) {
		const raw = decode(build({ html: "<p>x</p>", attachments: [{ ...image, contentId }] }).raw);
		assert.doesNotMatch(raw, /multipart\/related|Content-ID/, String(contentId));
	}
});

test("a comma-joined To element keeps every recipient in the header", async () => {
	const built = build({ to: ["A <a@x.com>, B <b@y.com>"], cc: ["c@w.com, d@w.com"] });
	const map = headers(built.raw);
	assert.deepEqual(map.get("to"), ["A <a@x.com>, B <b@y.com>"]);
	assert.deepEqual(map.get("cc"), ["c@w.com, d@w.com"]);
	const parsed = await parse(built);
	assert.match(parsed.toAddr, /a@x\.com.*b@y\.com/);
});

test("From is exactly one mailbox: a list or nothing is refused", () => {
	for (const from of ["a@x.com, b@y.com", "A <a@x.com>, B <b@y.com>", "", "   "])
		assert.throws(() => build({ from }), /exactly one From address/, JSON.stringify(from));
	assert.match(decode(build({ from: '"Doe, Jane" <jane@x.com>' }).raw), /^From: "Doe, Jane" <jane@x\.com>$/m);
});

test("Bcc never becomes a header, and mail with only Bcc says so", async () => {
	const built = build({ to: [], bcc: ["hidden@example.org"], headers: { Bcc: "hidden@example.org" } });
	const raw = decode(built.raw);
	assert.doesNotMatch(raw, /hidden/);
	assert.match(raw, /^To: undisclosed-recipients:;$/m);
	assertWellFormed(built.raw);
	assert.equal((await parse(built)).bccAddr, null);
});

test("non-ASCII subjects and names become encoded words that never split a character", async () => {
	const subject = "Grüße 👋🏽 из Москвы — 東京からの長い件名です。".repeat(3);
	const built = build({
		from: '"Jörg Müller" <user@example.test>',
		to: ["Zoë Ångström <zoe@example.org>", "plain@example.org"],
		subject,
	});
	assertWellFormed(built.raw);
	const map = headers(built.raw);
	assert.equal(decodeWords(map.get("subject")[0]), subject);
	for (const word of decode(built.raw).match(/=\?[^?]+\?B\?[^?]*\?=/g)) assert.ok(word.length <= 75, word);
	assert.equal(decodeWords(map.get("from")[0]), "Jörg Müller <user@example.test>");
	const parsed = await parse(built);
	assert.equal(parsed.subject, subject);
	assert.match(parsed.fromAddr, /Jörg Müller/);
	assert.match(parsed.toAddr, /Zoë Ångström.*zoe@example\.org.*plain@example\.org/);
});

test("encodedWords splits at 45 bytes on character boundaries", () => {
	assert.deepEqual(encodedWords(""), ["=?UTF-8?B??="]);
	const words = encodedWords("€".repeat(20));
	// 15 three-byte characters fill 45 bytes exactly.
	assert.deepEqual(
		words.map((word) => Buffer.from(word.slice(10, -2), "base64").length),
		[45, 15],
	);
	const emoji = encodedWords("👍".repeat(12));
	assert.deepEqual(
		emoji.map((word) => Buffer.from(word.slice(10, -2), "base64").length),
		[44, 4],
	);
});

test("long ASCII headers fold at whitespace and unfold to the same value", () => {
	const subject = "This subject is long enough that it has to be folded onto more than one line of the header";
	const raw = decode(build({ subject }).raw);
	assert.match(raw, /^Subject: This subject .*\r\n [^\r]+/m);
	assert.equal(headers(bytes(raw)).get("subject")[0], subject);
	assert.equal(foldHeader("X", []), "X:");
	assert.equal(foldHeader("X", ["a".repeat(100), "b"]), `X: ${"a".repeat(100)}\r\n b`);
	assert.equal(foldHeader("Subject", ["short"]), "Subject: short");
});

test("text headers: whitespace collapses, injection is impossible, and odd text is encoded", () => {
	const injected = decode(build({ subject: "Hi\r\nBcc: victim@example.org\r\n\r\nbody" }).raw);
	assert.doesNotMatch(injected, /^Bcc:/m);
	assert.match(injected, /^Subject: Hi Bcc: victim@example.org body$/m);
	assert.deepEqual(textTokens("  a \t b\n c  "), ["a", "b", "c"]);
	assert.deepEqual(textTokens(""), []);
	assert.equal(decodeWords(textTokens("=?UTF-8?B?Zm9v?= literal").join(" ")), "=?UTF-8?B?Zm9v?= literal");
	assert.match(textTokens("x".repeat(201))[0], /^=\?UTF-8\?B\?/);
	assert.deepEqual(textTokens("x".repeat(200)), ["x".repeat(200)]);
	assert.match(textTokens("bell\u0007")[0], /^=\?UTF-8\?B\?/);
});

test("display names are atoms, quoted strings or encoded words", () => {
	assert.deepEqual(addressTokens(["John Smith <john@example.org>"]), ["John", "Smith", "<john@example.org>"]);
	assert.deepEqual(addressTokens(['"Doe, John" <john@example.org>', "x@example.org"]), [
		'"Doe, John"',
		"<john@example.org>,",
		"x@example.org",
	]);
	assert.deepEqual(addressTokens(["Q. Public <q@example.org>"]), ['"Q. Public"', "<q@example.org>"]);
	assert.deepEqual(addressTokens(['"Back\\slash" <b@example.org>']), ['"Back\\\\slash"', "<b@example.org>"]);
	assert.deepEqual(addressTokens(["<only@example.org>"]), ["only@example.org"]);
	// One element holding a comma-joined header value keeps every address in it.
	assert.deepEqual(addressTokens(["A <a@x.com>, B <b@y.com>", '"Doe, J" <j@z.com>; c@w.com']), [
		"A",
		"<a@x.com>,",
		"B",
		"<b@y.com>,",
		'"Doe, J"',
		"<j@z.com>,",
		"c@w.com",
	]);
	assert.deepEqual(addressTokens(["Shop <info@bücher.example>"]), ["Shop", "<info@xn--bcher-kva.example>"]);
	assert.match(addressTokens(["Zoë <z@example.org>"])[0], /^=\?UTF-8\?B\?/);
	assert.throws(() => addressTokens(["jörg@example.org"]), /not an address/);
	assert.throws(() => build({ from: "not an address" }), /not an address/);
});

test("custom headers: threading headers fold, reserved names are ignored, bad names are refused", async () => {
	const references = Array.from({ length: 8 }, (_, index) => `<message-${index}-abcdefghij@example.org>`).join(" ");
	const built = build({
		text: "reply",
		headers: {
			"In-Reply-To": "<message-7-abcdefghij@example.org>",
			References: references,
			"Reply-To": "Zoë Support <support@example.org>, Other <other@example.org>",
			"Content-Type": "text/evil",
			"MIME-Version": "2.0",
			"X-Kite-Note": "Ünïcode note",
			"x-kite-note": "last one wins",
			"X-Empty": "   ",
		},
	});
	assertWellFormed(built.raw);
	const map = headers(built.raw);
	assert.deepEqual(map.get("references"), [references]);
	assert.deepEqual(map.get("content-type"), ["text/plain; charset=utf-8"]);
	assert.deepEqual(map.get("mime-version"), ["1.0"]);
	assert.deepEqual(map.get("x-kite-note"), ["last one wins"]);
	assert.equal(map.get("x-empty"), undefined);
	assert.match(decodeWords(map.get("reply-to")[0]), /^Zoë Support <support@example.org>, Other <other@example.org>$/);
	const parsed = await parse(built);
	assert.equal(parsed.inReplyTo, "message-7-abcdefghij@example.org");
	assert.equal(parsed.references.length, 8);
	for (const name of ["Bad Name", "Colon:", "Ünï", ""])
		assert.throws(() => build({ headers: { [name]: "x" } }), /not a valid header name/, name);
});

test("Message-ID: the option wins, then the caller's header, then a minted one on the From domain", () => {
	assert.equal(build({ headers: { "Message-ID": "<h@example.test>" } }).messageId, "<test-1@example.test>");
	const fromHeader = buildMimeMessage(
		{ from: FROM, to: ["a@example.org"], subject: "x", headers: { "message-id": "h@example.test" } },
		{ date: DATE },
	);
	assert.equal(fromHeader.messageId, "<h@example.test>");
	assert.match(decode(fromHeader.raw), /^Message-ID: <h@example.test>$/m);
	const minted = buildMimeMessage({ from: FROM, to: ["a@example.org"], subject: "x" });
	assert.match(minted.messageId, /^<kite\.[0-9a-f-]{36}@example\.test>$/);
	assert.match(decode(minted.raw), /^Date: \w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} \+0000$/m);
	assert.equal(mintMessageId("Shop <info@Bücher.example>", "msg_42/x"), "<kite.msg_42x@xn--bcher-kva.example>");
	assert.equal(normalizeMessageId(" abc@def "), "<abc@def>");
	for (const value of ["", "<>", "no-at", "a b@c", "a@b\r\nX: y", "<a<b@c>", `${"a".repeat(900)}@b`])
		assert.throws(() => normalizeMessageId(value), /Message-ID is not valid/, value);
});

test("formatMailDate is RFC 5322 in UTC", () => {
	assert.equal(formatMailDate(new Date("2026-01-04T23:59:59.999Z")), "Sun, 04 Jan 2026 23:59:59 +0000");
	assert.equal(formatMailDate(DATE), "Thu, 29 Oct 2026 09:05:03 +0000");
});

test("text bodies: 7bit when safe, quoted-printable otherwise, with lines of at most 76", async () => {
	const longAscii = "word ".repeat(150).trim();
	for (const [body, encoding] of [
		["Plain ASCII\nwith . dots\n.\n", "7bit"],
		["café", "quoted-printable"],
		["a boundary-like =_ sequence", "quoted-printable"],
		["x".repeat(999), "quoted-printable"],
		["word ".repeat(300).trim(), "quoted-printable"],
		[longAscii, "7bit"],
		["tab\tand bell\u0007", "quoted-printable"],
	]) {
		const built = build({ text: body });
		assert.match(decode(built.raw), new RegExp(`Content-Transfer-Encoding: ${encoding}`), body.slice(0, 20));
		assertWellFormed(built.raw);
		const parsed = await parse(built);
		assert.equal(parsed.text.replace(/\r?\n$/, ""), body.replace(/\n$/, "").replace(/\r?\n/g, "\n"));
	}
});

test("encodeQuotedPrintable escapes what it must and never splits an escape", () => {
	assert.equal(encodeQuotedPrintable("a=b"), "a=3Db");
	assert.equal(encodeQuotedPrintable("trailing space \r\ntab\t"), "trailing space=20\r\ntab=09");
	assert.equal(encodeQuotedPrintable("in the middle"), "in the middle");
	assert.equal(encodeQuotedPrintable(""), "");
	assert.equal(encodeQuotedPrintable("x".repeat(76)), "x".repeat(76));
	assert.equal(encodeQuotedPrintable("x".repeat(77)), `${"x".repeat(75)}=\r\nxx`);
	for (const sample of ["é".repeat(60), `${"a".repeat(74)}é${"b".repeat(10)}`, "ü ".repeat(50), "=".repeat(80)]) {
		const encoded = encodeQuotedPrintable(sample);
		for (const line of encoded.split("\r\n")) {
			assert.ok(line.length <= 76, line);
			assert.doesNotMatch(line, /=[0-9A-F]?$(?<!=)/, "no cut escape");
		}
		assert.doesNotMatch(encoded, /=[0-9A-F]?\r\n(?<!=\r\n)/);
		assert.equal(decodeQuotedPrintable(encoded), sample);
	}
});

test("encodeBase64Lines matches Node's base64 in 76-column CRLF lines", () => {
	for (const length of [0, 1, 2, 3, 56, 57, 58, 114, 1000]) {
		const input = Uint8Array.from({ length }, (_, index) => (index * 31 + 7) % 256);
		const expected = (
			Buffer.from(input)
				.toString("base64")
				.match(/.{1,76}/g) ?? []
		)
			.map((line) => `${line}\r\n`)
			.join("");
		assert.equal(decode(encodeBase64Lines(input)), expected, String(length));
	}
});

test("file names: quoted when short ASCII, RFC 2231 sections otherwise, and they parse back", async () => {
	assert.deepEqual(parameterTokens("filename", "report.pdf"), ['filename="report.pdf"']);
	assert.deepEqual(parameterTokens("filename", 'a "b" \\c'), ['filename="a \\"b\\" \\\\c"']);
	assert.deepEqual(parameterTokens("filename", "Grüße.txt"), ["filename*=utf-8''Gr%C3%BC%C3%9Fe.txt"]);
	assert.deepEqual(parameterTokens("name", "=?looks-encoded?="), ["name*=utf-8''%3D%3Flooks-encoded%3F%3D"]);
	const long = `${"Jahresbericht über die Entwicklung ".repeat(4)}東京.pdf`;
	const sections = parameterTokens("filename", long);
	assert.ok(sections.length > 2);
	assert.match(sections[0], /^filename\*0\*=utf-8''/);
	assert.match(sections[1], /^filename\*1\*=[^']/);
	for (const [index, section] of sections.entries()) {
		assert.ok(section.length <= 75);
		assert.equal(section.endsWith(";"), index < sections.length - 1);
		assert.doesNotMatch(section, /%[0-9A-F]?;?$/, "no cut escape");
	}
	const built = build({
		text: "x",
		attachments: [
			{ filename: long, type: "application/pdf", content: new ArrayBuffer(4), disposition: "attachment" },
			{ filename: "Grüße.txt", type: "text/plain", content: new ArrayBuffer(1), disposition: "attachment" },
			{ filename: "\r\n", type: "", content: new ArrayBuffer(1), disposition: "attachment" },
		],
	});
	assertWellFormed(built.raw);
	const names = (await parse(built)).attachments.map((attachment) => attachment.filename);
	assert.deepEqual(names, [long, "Grüße.txt", "attachment"]);
	assert.match(decode(built.raw), /Content-Type: application\/octet-stream; name="attachment"/);
});

test("mediaType keeps valid types without parameters and falls back otherwise", () => {
	assert.equal(mediaType("Image/PNG"), "image/png");
	assert.equal(mediaType("text/plain; charset=utf-8"), "text/plain");
	assert.equal(mediaType("application/vnd.ms-excel"), "application/vnd.ms-excel");
	for (const value of ["", "image", "image/", "a/b c", "x/y\r\nX-Evil: 1", "/png"])
		assert.equal(mediaType(value), "application/octet-stream", value);
});

test("the builder leaves dot-stuffing to the SMTP client", () => {
	const raw = decode(build({ text: ".\n..\n.leading" }).raw);
	assert.match(raw, /\r\n\r\n\.\r\n\.\.\r\n\.leading\r\n$/);
});

test("boundaries come from random bytes and never appear in an encoded body", () => {
	const built = build({ text: "a", html: "<p>b</p>" }, { randomBytes: () => new Uint8Array(12).fill(255) });
	assert.match(decode(built.raw), /boundary="=_kite_ffffffffffffffffffffffff"/);
	const real = decode(build({ text: "a", html: "<p>b</p>" }).raw);
	const [boundary] = /=_kite_[0-9a-f]{24}/.exec(real);
	assert.equal(real.split(`--${boundary}`).length, 4);
});
