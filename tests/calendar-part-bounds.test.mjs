import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import PostalMime from "postal-mime";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

// postal-mime decodes a calendar part whole into a string to store it as UTF-8. Over the limit, the part stays a plain
// attachment instead. The large cases run in a child process with a 64 MB heap: the two-byte one needed about 112 MB.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-calendar-part-bounds-");
after(() => rmSync(directory, { recursive: true, force: true }));

const entry = join(directory, "entry.ts");
writeFileSync(
	entry,
	`
export { parseRawMime } from "${root}/src/lib/email/parse";
export { MAX_DECODED_CALENDAR_BYTES } from "${root}/src/lib/email/mime-body-utils";
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
const { MAX_DECODED_CALENDAR_BYTES, parseRawMime } = await import(pathToFileURL(bundle).href);
const MiB = 1024 * 1024;
const full = 24 * MiB;

test("a calendar part is read as text up to 1 MiB", () => {
	assert.equal(MAX_DECODED_CALENDAR_BYTES, MiB);
});

const worker = join(directory, "worker.mjs");
writeFileSync(
	worker,
	`
import { parseRawMime } from ${JSON.stringify(pathToFileURL(bundle).href)};

const header = 'From: a@example.com\\r\\nTo: b@example.com\\r\\nSubject: x\\r\\nMIME-Version: 1.0\\r\\nContent-Type: multipart/mixed; boundary="B"\\r\\n\\r\\n--B\\r\\nContent-Type: text/plain\\r\\n\\r\\nhi\\r\\n';
const MiB = 1024 * 1024;
// 200-byte lines of \`unit\`, kept a one-byte string here so only the parser could hold two-byte copies.
const body = (size, unit) => (unit.repeat(Math.ceil(198 / unit.length)).slice(0, 198) + "\\r\\n").repeat(Math.floor(size / 200));
const encode = (pieces) => {
	const bytes = Buffer.concat(pieces.map(([piece, charset = "utf8"]) => Buffer.from(piece, charset)));
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};
const part = (fields, ...content) => [["--B\\r\\n" + fields + "\\r\\n\\r\\n"], ...content, ["\\r\\n"]];
const message = (...parts) => encode([[header], ...parts.flat(), ["--B--\\r\\n"]]);
const euro = "\\u20ac";
const words = "abcd efgh ";
const cyrillic = "\\xb0\\xb1\\xb2\\xb3 \\xd0\\xd1\\xd2 ";
const base64 = (size) => Buffer.concat([Buffer.from(euro), Buffer.from(body(size, words))]).toString("base64").replace(/.{76}/g, "$&\\r\\n");
const full = 24 * MiB;
const shapes = {
	attachment: () => message(part("Content-Type: text/calendar; method=REQUEST; charset=utf-8\\r\\nContent-Disposition: attachment; filename=invite.ics", [euro], [body(full, words)])),
	inline: () => message(part("Content-Type: text/calendar; method=REQUEST; charset=utf-8", [euro], [body(full, words)])),
	singleByteCharset: () => message(part("Content-Type: text/calendar; charset=iso-8859-5", [body(full, cyrillic), "latin1"])),
	base64: () => message(part("Content-Type: application/ics; name=invite.ics\\r\\nContent-Transfer-Encoding: base64", [base64(18 * MiB)])),
	// Each just under the limit, so every one is still read as text.
	manyUnderLimit: () => message(...Array.from({ length: 23 }, () => part("Content-Type: text/calendar; charset=utf-8\\r\\nContent-Disposition: attachment; filename=i.ics", [euro], [body(MiB, words)]))),
};

const out = {};
for (const [name, build] of Object.entries(shapes)) {
	const raw = build();
	const started = performance.now();
	const parsed = await parseRawMime(raw);
	out[name] = {
		text: parsed.text,
		attachments: parsed.attachments.map(({ type, filename, content }) => ({ type, filename, bytes: content.byteLength ?? content.length })),
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

test("24 MB calendar parts, also two bytes per character, are kept as attachments within a 64 MB heap", () => {
	const output = execFileSync(process.execPath, ["--max-old-space-size=64", worker], {
		encoding: "utf8",
		env: childEnv,
		timeout: 300_000,
	});
	const results = JSON.parse(output);
	assert.equal(Object.keys(results).length, 5);
	for (const [name, result] of Object.entries(results)) {
		assert.ok(result.ms < 60_000, `${name}: ${result.ms} ms`);
		assert.equal(result.text, "hi", name);
	}
	// The decoded bytes as sent: neither re-encoded as UTF-8 nor with their line ends changed.
	const [attachment] = results.attachment.attachments;
	assert.deepEqual(attachment, {
		type: "text/calendar",
		filename: "invite.ics",
		bytes: 3 + Math.floor(full / 200) * 200,
	});
	assert.deepEqual(results.inline.attachments, [{ ...attachment, filename: "attachment-1" }]);
	assert.deepEqual(results.singleByteCharset.attachments, [
		{ ...attachment, filename: "attachment-1", bytes: Math.floor(full / 200) * 200 },
	]);
	const [ics] = results.base64.attachments;
	assert.equal(ics.type, "application/ics");
	assert.equal(ics.filename, "invite.ics");
	assert.ok(ics.bytes > 18_000_000, `${ics.bytes} bytes`);
	// Read as text: line ends become LF, so each part is one byte per line smaller.
	assert.equal(results.manyUnderLimit.attachments.length, 23);
	for (const part of results.manyUnderLimit.attachments) {
		assert.equal(part.type, "text/calendar");
		assert.equal(part.bytes, 3 + Math.floor(MiB / 200) * 199);
	}
});

const invite = [
	"BEGIN:VCALENDAR",
	"VERSION:2.0",
	"METHOD:REQUEST",
	"BEGIN:VEVENT",
	"UID:abc@example.com",
	"DTSTART:20261110T090000Z",
	"DTEND:20261110T100000Z",
	"SUMMARY:Café",
	"END:VEVENT",
	"END:VCALENDAR",
	"",
	"",
].join("\r\n");
const header = "From: a@example.com\r\nTo: b@example.com\r\nSubject: x\r\nMIME-Version: 1.0\r\n";
const toBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const mixed = (...parts) =>
	toBuffer(
		Buffer.concat([
			Buffer.from(
				`${header}Content-Type: multipart/mixed; boundary="B"\r\n\r\n--B\r\nContent-Type: text/plain\r\n\r\nhi\r\n`,
			),
			...parts.flatMap(([fields, content]) => [Buffer.from(`--B\r\n${fields}\r\n\r\n`), content, Buffer.from("\r\n")]),
			Buffer.from("--B--\r\n"),
		]),
	);
const bytesOf = (content) => Buffer.from(content instanceof ArrayBuffer ? new Uint8Array(content) : content);

test("an invitation under the limit is read exactly as postal-mime reads it", async () => {
	const raw = mixed(
		["Content-Type: text/calendar; method=REQUEST; charset=iso-8859-1", Buffer.from(invite, "latin1")],
		[
			"Content-Type: application/ics; name=invite.ics\r\nContent-Transfer-Encoding: base64",
			Buffer.from(Buffer.from(invite).toString("base64")),
		],
	);
	const parsed = await parseRawMime(raw);
	const reference = await PostalMime.parse(raw, { forceRfc822Attachments: true });
	assert.equal(parsed.attachments.length, 2);
	for (const [index, attachment] of parsed.attachments.entries()) {
		assert.equal(attachment.type, reference.attachments[index].mimeType);
		assert.deepEqual(bytesOf(attachment.content), bytesOf(reference.attachments[index].content));
	}
	// Re-encoded as UTF-8 with LF line ends and one final newline.
	assert.equal(bytesOf(parsed.attachments[0].content).toString("utf8"), `${invite.replace(/\r\n/g, "\n").trimEnd()}\n`);
});

test("a calendar part is read as text up to the limit and kept as sent past it", async () => {
	const lines = (size) => Buffer.from(`${"x".repeat(98)}\r\n`.repeat(size / 100));
	const atLimit = lines(MiB - (MiB % 100));
	const overLimit = Buffer.concat([atLimit, Buffer.from("y".repeat((MiB % 100) + 1))]);
	assert.equal(overLimit.length, MiB + 1);
	const parsed = await parseRawMime(
		mixed(
			[
				"Content-Type: text/calendar\r\nContent-Disposition: attachment; filename=big.ics\r\nContent-ID: <big@x>",
				overLimit,
			],
			["Content-Type: text/calendar; method=REQUEST", Buffer.from(invite)],
			["Content-Type: text/calendar", Buffer.concat([atLimit, Buffer.from("y".repeat(MiB % 100))])],
		),
	);
	const [big, small, edge] = parsed.attachments;
	assert.deepEqual(
		{ type: big.type, filename: big.filename, disposition: big.disposition, contentId: big.contentId },
		{ type: "text/calendar", filename: "big.ics", disposition: "attachment", contentId: "<big@x>" },
	);
	assert.deepEqual(bytesOf(big.content), overLimit);
	// A part after the large one is still read as an invitation.
	assert.equal(small.type, "text/calendar");
	assert.equal(bytesOf(small.content).toString("utf8"), `${invite.replace(/\r\n/g, "\n").trimEnd()}\n`);
	// Exactly at the limit: read as text, so CRLF became LF and a final newline was added.
	assert.equal(edge.type, "text/calendar");
	assert.equal(bytesOf(edge.content).length, MiB - (MiB - (MiB % 100)) / 100 + 1);
});
