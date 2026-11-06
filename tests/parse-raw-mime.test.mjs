import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

// What `parseRawMime` hands the rest of Kite, for the readings postal-mime 2.7 and 4.x differ on.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-parse-raw-mime-test-");
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { parseRawMime } from "./src/lib/email/parse.ts";
			export { locateAttachmentParts } from "./src/lib/email/attachment-storage-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "parse-raw-mime-test-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	absWorkingDir: root,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	alias: { "@": join(root, "src") },
	packages: "external",
	logLevel: "silent",
});
const { locateAttachmentParts, parseRawMime } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const parse = (raw) => parseRawMime(new TextEncoder().encode(raw).buffer);
const decoder = new TextDecoder();
const mixed = (...parts) =>
	`From: a@example.com\r\nContent-Type: multipart/mixed; boundary="b"\r\n\r\n${parts.map((part) => `--b\r\n${part}\r\n`).join("")}--b--\r\n`;

test("format=flowed unfolds as RFC 3676 reads it", async () => {
	const flowed = async (params, body) =>
		(await parse(`From: a@example.com\r\nContent-Type: text/plain; format=flowed${params}\r\n\r\n${body}`)).text;
	assert.equal(await flowed("", "one \r\ntwo\r\nthree\r\n"), "one two\nthree\n");
	assert.equal(await flowed("; delsp=yes", "on \r\ne\r\n"), "one\n");
	assert.equal(await flowed("", " From me\r\n"), "From me\n");
	assert.equal(await flowed("", "> quoted \r\n> reply\r\nnext\r\n"), "> quoted reply\nnext\n");
	// The signature separator ends a paragraph and is neither flowed nor fixed.
	assert.equal(await flowed("", "text \r\n-- \r\nJane\r\n"), "text \n-- \nJane\n");
	// format=flowed is for text/plain only: an HTML part stays as it was sent.
	const html = await parse(
		"From: a@example.com\r\nContent-Type: text/html; format=flowed; delsp=yes\r\n\r\n<p>on \r\ne</p>\r\n",
	);
	assert.match(html.html, /on \ne/);
});

test("folding whitespace stays out of stored subjects, names and file names", async () => {
	const parsed = await parse(
		[
			"From: Jane\r\n\tDoe <jane@example.com>",
			'To: "Quoted\r\n\tName" <q@example.com>, Plain\r\n   Words <p@example.com>',
			"Subject: one\r\n\ttwo\r\n   three",
			'Content-Type: multipart/mixed; boundary="b"',
			"",
			'--b\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="long\r\n\tname.pdf"\r\n\r\nx',
			"--b--",
			"",
		].join("\r\n"),
	);
	assert.equal(parsed.subject, "one two three");
	assert.equal(parsed.fromAddr, '"Jane Doe" <jane@example.com>');
	assert.equal(parsed.toAddr, '"Quoted Name" <q@example.com>, "Plain Words" <p@example.com>');
	assert.equal(parsed.attachments[0].filename, "long name.pdf");
});

test("duplicated headers: the first counts, address lists keep document order", async () => {
	const parsed = await parse(
		[
			"Message-ID: <one@example.com>",
			"Message-ID: <two@example.com>",
			"In-Reply-To: <p@example.com>",
			"In-Reply-To: <q@example.com>",
			"References: <r@example.com>",
			"References: <s@example.com>",
			"Subject: first",
			"Subject: second",
			"From: a@example.com",
			"From: b@example.com",
			"To: c@example.com",
			"To: d@example.com",
			"Cc: e@example.com",
			"Cc: f@example.com",
			"",
			"hi",
			"",
		].join("\r\n"),
	);
	assert.equal(parsed.subject, "first");
	assert.equal(parsed.fromAddr, "a@example.com");
	assert.equal(parsed.messageId, "<one@example.com>");
	assert.equal(parsed.inReplyTo, "p@example.com");
	assert.deepEqual(parsed.references, ["r@example.com"]);
	assert.equal(parsed.toAddr, "c@example.com, d@example.com");
	assert.equal(parsed.ccAddr, "e@example.com, f@example.com");
});

test("folded threading headers read as they did", async () => {
	const parsed = await parse(
		"Message-ID:\r\n <m@example.com>\r\nIn-Reply-To:\r\n <c@example.com>\r\nReferences: <a@example.com>\r\n <b@example.com>\r\n\t<c@example.com>\r\nFrom: a@example.com\r\n\r\nhi\r\n",
	);
	assert.equal(parsed.messageId, "<m@example.com>");
	assert.equal(parsed.inReplyTo, "c@example.com");
	assert.deepEqual(parsed.references, ["a@example.com", "b@example.com", "c@example.com"]);
});

test("charsets: legacy mail reads as text, not replacement characters", async () => {
	const latin1 = (raw) => parseRawMime(new Uint8Array(Buffer.from(raw, "latin1")).buffer);
	const noCharset = await latin1("From: a@example.com\r\nSubject: café\r\n\r\ncafé\r\n");
	assert.equal(noCharset.subject, "café");
	assert.equal(noCharset.text, "café\n");
	const unknown = await latin1("From: a@example.com\r\nContent-Type: text/plain; charset=x-nope\r\n\r\ncafé\r\n");
	assert.equal(unknown.text, "café\n");
	const koi8 = await latin1("From: a@example.com\r\nContent-Type: text/plain; charset=koi8-r\r\n\r\nðÒÉ\r\n");
	assert.equal(koi8.text, "При\n");
	const meta = await latin1(
		'From: a@example.com\r\nContent-Type: text/html\r\n\r\n<meta charset="iso-8859-1"><p>café</p>\r\n',
	);
	assert.match(meta.html, /café/);
	const encodedName = await parse("From: =?UTF-8?Q?Caf=C3=A9?= <a@example.com>\r\n\r\nhi\r\n");
	assert.equal(encodedName.fromAddr, '"Café" <a@example.com>');
});

test("dispositions other than inline stay attachments, and the OTP header is not stored", async () => {
	const parsed = await parse(
		mixed(
			"Content-Type: image/png\r\nContent-Disposition: form-data; filename=a.png\r\nContent-Transfer-Encoding: base64\r\n\r\nQUFB",
			"Content-Type: image/png\r\nContent-Disposition: inline; filename=b.png\r\nContent-ID: <b@example.com>\r\nContent-Transfer-Encoding: base64\r\n\r\nQUFB",
		).replace("From:", "OTP-Token: 123456; origin=https://example.com\r\nFrom:"),
	);
	assert.deepEqual(
		parsed.attachments.map((attachment) => [attachment.disposition, attachment.contentId]),
		[
			["attachment", null],
			["inline", "<b@example.com>"],
		],
	);
	assert.ok(!JSON.stringify({ ...parsed, attachments: [] }).includes("123456"));
});

test("calendar invites reach the invite parser as text ending in one newline", async () => {
	const ics = "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR";
	const plain = await parse(mixed(`Content-Type: text/calendar; method=REQUEST\r\n\r\n${ics}`));
	const encoded = await parse(
		mixed(
			`Content-Type: text/calendar; method=REQUEST\r\nContent-Disposition: attachment; filename=i.ics\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(ics).toString("base64")}`,
		),
	);
	for (const parsed of [plain, encoded])
		assert.equal(decoder.decode(parsed.attachments[0].content), `${ics.replaceAll("\r\n", "\n")}\n`);
	assert.equal(plain.attachments[0].type, "text/calendar");
});

test("attachments sent unencoded keep their bytes and sit in the raw message", async () => {
	const forwarded = "From: i@example.com\r\nSubject: in\r\n\r\ninner\r\nbody";
	const raw = new TextEncoder().encode(
		mixed(
			"Content-Type: text/plain\r\n\r\nsee below",
			`Content-Type: message/rfc822\r\nContent-Disposition: attachment; filename=f.eml\r\n\r\n${forwarded}`,
			"Content-Type: application/octet-stream\r\nContent-Transfer-Encoding: binary\r\nContent-Disposition: attachment; filename=d.bin\r\n\r\none\r\ntwo\ntree",
		),
	);
	const parsed = await parseRawMime(raw.buffer);
	assert.equal(parsed.text, "see below");
	const contents = parsed.attachments.map((attachment) => decoder.decode(attachment.content));
	assert.deepEqual(contents, [forwarded, "one\r\ntwo\ntree"]);
	const located = locateAttachmentParts(raw, parsed.attachments);
	assert.equal(located.size, 2);
	for (const [index, part] of located) {
		assert.equal(part.encoding, "identity");
		assert.equal(decoder.decode(raw.subarray(part.offset, part.offset + part.length)), contents[index]);
	}
});
