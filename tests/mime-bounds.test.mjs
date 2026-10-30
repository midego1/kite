import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

// Hostile MIME (Mailflare #214) is parsed in a child process with a 128 MB heap, so a bound that stops working
// shows up as a crash or a timeout instead of slowing the whole test run.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-mime-bounds-");
after(() => rmSync(directory, { recursive: true, force: true }));

const entry = join(directory, "entry.ts");
writeFileSync(
	entry,
	`
import { MimeLimitError, parseRawMime } from "${root}/src/lib/email/parse";
import { inboundAttachmentLimitReason, inboundAttachmentLimitReasonFromRaw } from "${root}/src/lib/email/inbound-attachments";
import { htmlToReadableText } from "${root}/src/lib/email/reply-content-utils";

const encoder = new TextEncoder();
const header = "From: a@b.example\\r\\nTo: c@d.example\\r\\nSubject: x\\r\\n";
const multipart = (boundary) => \`Content-Type: multipart/mixed; boundary="\${boundary}"\\r\\n\\r\\n\`;
const base64Lines = (count) => ("QUFB".repeat(19) + "\\r\\n").repeat(count);
const pdfPart = (boundary) =>
	\`--\${boundary}\\r\\nContent-Type: application/pdf\\r\\nContent-Transfer-Encoding: base64\\r\\nContent-Disposition: attachment; filename=a.pdf\\r\\n\\r\\n\` +
	base64Lines(340000);
// A forwarded message is one leaf part to postal-mime, read line by line even where its own body is base64: these
// exhaust a 128 MB heap, so their lines count however the inner message is encoded.
const forwardedMessage = (inner) => header + multipart("b") + "--b\\r\\nContent-Type: message/rfc822\\r\\n\\r\\n" + header + inner + "--b--\\r\\n";
const hostile = {
	blankLines: () => header + "\\r\\n" + "\\r\\n".repeat(512 * 1024),
	shortLines: () => header + "\\r\\n" + "a\\r\\n".repeat(262144),
	spaceLines: () => header + "\\r\\n" + " \\r\\n".repeat(262144),
	textLines: () => header + "\\r\\n" + ("a".repeat(78) + "\\r\\n").repeat(262144),
	bareLfLines: () => header + "\\n" + "a\\n".repeat(262144),
	// A line that looks like a boundary must not leave the lines after it uncounted.
	fakeBoundaryLines: () => header + "\\r\\n--x\\r\\n" + "a\\r\\n".repeat(262144),
	// Lines in a part's header block count too.
	partHeaderLines: () => header + multipart("b") + "--b\\r\\n" + "X-A: 1\\r\\n".repeat(262144),
	forwardedBase64Body: () => forwardedMessage("Content-Type: application/pdf\\r\\nContent-Transfer-Encoding: base64\\r\\n\\r\\n" + base64Lines(340000)),
	forwardedMultipartBase64: () => forwardedMessage(multipart("i") + pdfPart("i") + "--i--\\r\\n"),
	// A text attachment costs postal-mime what a text body does.
	textAttachment: () =>
		header + multipart("b") + "--b\\r\\nContent-Type: text/csv\\r\\nContent-Disposition: attachment; filename=a.csv\\r\\n\\r\\n" + "a,b\\r\\n".repeat(262144) + "--b--\\r\\n",
	// Re-review of #237: shapes where a scan that read the structure differently from postal-mime exempted lines
	// postal-mime reads as text.
	// 1. A boundary parameter next to another parameter whose value says "boundary", under a base64 top level.
	boundaryWordInValue: () =>
		header +
		'Content-Type: multipart/mixed; boundary="b"; foo="boundary"\\r\\nContent-Transfer-Encoding: base64\\r\\n\\r\\n' +
		"--b\\r\\nContent-Type: text/plain\\r\\n\\r\\n" +
		"a\\r\\n".repeat(300000) +
		"--b--\\r\\n",
	boundaryWordInValueParts: () =>
		header +
		'Content-Type: multipart/mixed; boundary="b"; foo="boundary"\\r\\nContent-Transfer-Encoding: base64\\r\\n\\r\\n' +
		"--b\\r\\nContent-Type: text/plain\\r\\n\\r\\nx\\r\\n".repeat(20000),
	// 2. A boundary line ending in two carriage returns after a base64 part: postal-mime strips them all.
	carriageReturnBoundary: () =>
		header +
		multipart("b") +
		"--b\\r\\nContent-Type: application/pdf\\r\\nContent-Transfer-Encoding: base64\\r\\n\\r\\nQUFB\\r\\n" +
		"--b\\r\\r\\nContent-Type: text/plain\\r\\n\\r\\n" +
		"a\\r\\n".repeat(300000) +
		"--b--\\r\\n",
	// 3. Two transfer encodings: postal-mime uses the first.
	firstEncodingWins: () =>
		header +
		multipart("b") +
		"--b\\r\\nContent-Type: text/plain\\r\\nContent-Transfer-Encoding: 7bit\\r\\nContent-Transfer-Encoding: base64\\r\\n\\r\\n" +
		"a\\r\\n".repeat(300000) +
		"--b--\\r\\n",
	// 4. A closed boundary inside a later text part: postal-mime no longer matches it.
	staleBoundary: () =>
		header +
		multipart("o") +
		'--o\\r\\nContent-Type: multipart/alternative; boundary="b"\\r\\n\\r\\n--b\\r\\nContent-Type: text/plain\\r\\n\\r\\nhi\\r\\n--b--\\r\\n' +
		"--o\\r\\nContent-Type: text/plain\\r\\n\\r\\n--b\\r\\nContent-Transfer-Encoding: base64\\r\\n\\r\\n" +
		"a\\r\\n".repeat(300000) +
		"--o--\\r\\n",
	// Boundaries a parser may read differently are refused outright.
	duplicateBoundary: () => header + 'Content-Type: multipart/mixed; boundary="a"; boundary="b"\\r\\n\\r\\n--b\\r\\n\\r\\nx\\r\\n--b--\\r\\n',
	continuedBoundary: () => header + "Content-Type: multipart/mixed; boundary*0=b; boundary*1=c\\r\\n\\r\\n--bc\\r\\n\\r\\nx\\r\\n--bc--\\r\\n",
	escapedBoundary: () => header + 'Content-Type: multipart/mixed; boundary="a\\\\b"\\r\\n\\r\\n--ab\\r\\n\\r\\nx\\r\\n--ab--\\r\\n',
	parts: () => header + multipart("b") + "--b\\r\\nContent-Type: text/plain\\r\\n\\r\\nx\\r\\n".repeat(20000),
	headerBlock: () => "X-Pad: " + "a".repeat(200 * 1024) + "\\r\\n\\r\\nbody",
	deepMultipart: () =>
		header +
		Array.from({ length: 30 }, (_, depth) => \`Content-Type: multipart/mixed; boundary="b\${depth}"\\r\\n\\r\\n--b\${depth}\\r\\n\`).join("") +
		"Content-Type: text/plain\\r\\n\\r\\nx\\r\\n",
};
// Two runs, each in its own 128 MB process: the hostile shapes, then the legitimate large ones.
const mode = process.argv[2];
const out = { rejected: {}, edge: {}, slowestMs: 0, ok: {} };
if (mode === "hostile") for (const [name, build] of Object.entries(hostile)) {
	const raw = encoder.encode(build()).buffer;
	const started = performance.now();
	try {
		await parseRawMime(raw);
		out.rejected[name] = null;
	} catch (error) {
		out.rejected[name] = error instanceof MimeLimitError ? error.message : "other: " + error;
	}
	out.edge[name] = await inboundAttachmentLimitReasonFromRaw(raw);
	out.slowestMs = Math.max(out.slowestMs, performance.now() - started);
}
if (mode === "legit") {
// A 25 MB-class base64 attachment is about 340,000 short lines and must still parse.
{
const pdf =
	multipart("b") +
	"--b\\r\\nContent-Type: application/pdf\\r\\nContent-Transfer-Encoding: base64\\r\\nContent-Disposition: attachment; filename=a.pdf\\r\\n\\r\\n";
const legit = header + pdf + base64Lines(340000) + "--b--\\r\\n";
out.ok.attachments = (await parseRawMime(encoder.encode(legit).buffer)).attachments.length;
}
// A base64 attachment of short lines stays cheap however many there are (a 25 MB message holds about 12 million).
{
let shortStarted = performance.now();
const shortLines = header + multipart("b") + "--b\\r\\nContent-Type: application/octet-stream\\r\\nContent-Transfer-Encoding: base64\\r\\n\\r\\n" + "A\\r\\n".repeat(3_000_000) + "--b--\\r\\n";
out.ok.shortLines = (await parseRawMime(encoder.encode(shortLines).buffer)).attachments.length;
out.ok.shortLinesMs = performance.now() - shortStarted;
}
// A comment and a second header line folded with a tab, as postal-mime unfolds them.
{
const commented = header + 'Content-Type: multipart/mixed; (a comment; boundary=x)\\r\\n\\tboundary="c"\\r\\n\\r\\n' + pdfPart("c") + "--c--\\r\\n";
out.ok.commented = (await parseRawMime(encoder.encode(commented).buffer)).attachments.length;
}
// format=flowed text is unfolded in linear time: 39,000 flowed 60-character lines (2.4 MB) took about 25 s with
// postal-mime 2.7's own decoder.
{
const flowed = header + "Content-Type: text/plain; charset=utf-8; format=flowed; delsp=yes\\r\\n\\r\\n" + ("a".repeat(59) + " \\r\\n").repeat(39_000);
let flowedStarted = performance.now();
const flowedText = (await parseRawMime(encoder.encode(flowed).buffer)).text ?? "";
out.ok.flowedMs = performance.now() - flowedStarted;
out.ok.flowedBytes = flowed.length;
out.ok.flowedUnfolded = flowedText.length === 39_000 * 59 && !flowedText.includes("\\n");
}
// The boundary parameter on a folded line, as most mail clients write it.
{
const folded = header + 'Content-Type: multipart/mixed;\\r\\n\\tboundary="f"\\r\\n\\r\\n' + pdfPart("f") + "--f--\\r\\n";
out.ok.folded = (await parseRawMime(encoder.encode(folded).buffer)).attachments.length;
}
// A forwarded message whose part is itself base64 (as some clients send it) is decoded in chunks.
{
const encodedForward =
	header + multipart("b") + "--b\\r\\nContent-Type: message/rfc822\\r\\nContent-Transfer-Encoding: base64\\r\\n\\r\\n" + base64Lines(340000) + "--b--\\r\\n";
out.ok.encodedForward = (await parseRawMime(encoder.encode(encodedForward).buffer)).attachments.map((a) => a.type);
}
// Thousands of nested message headers are one leaf part, not thousands of parses.
let nestedStarted = performance.now();
out.ok.nested = (await parseRawMime(encoder.encode(header + "Content-Type: message/rfc822\\r\\n\\r\\n".repeat(5000)).buffer)).subject;
out.ok.nestedMs = performance.now() - nestedStarted;
// A Mailman digest of 25 posts: 25 attached messages, which do not count as files.
const posts = Array.from({ length: 25 }, (_, n) => \`--d\\r\\n\\r\\nFrom: p\${n}@list.example\\r\\nSubject: Post \${n}\\r\\n\\r\\nBody \${n}\\r\\n\`).join("");
const digest =
	header + multipart("m") + "--m\\r\\nContent-Type: text/plain\\r\\n\\r\\nToday's topics\\r\\n--m\\r\\n" +
	'Content-Type: multipart/digest; boundary="d"\\r\\n\\r\\n' + posts + "--d--\\r\\n--m--\\r\\n";
const parsedDigest = await parseRawMime(encoder.encode(digest).buffer);
out.ok.digest = parsedDigest.attachments.filter((a) => a.type === "message/rfc822").length;
out.ok.digestEdge = await inboundAttachmentLimitReasonFromRaw(encoder.encode(digest).buffer);
const file = (type) => ({ filename: "f", type, content: new ArrayBuffer(10), disposition: "attachment", contentId: null });
out.ok.ninePlusTwoForwards = inboundAttachmentLimitReason([...Array(9)].map(() => file("application/pdf")).concat([file("message/rfc822"), file("MESSAGE/RFC822")]));
out.ok.elevenFiles = inboundAttachmentLimitReason([...Array(11)].map(() => file("application/pdf")));
// A parse error that is not a limit (here a body stream that breaks) is thrown, so the sender or the queue tries again.
try {
	await inboundAttachmentLimitReasonFromRaw({ getReader() { throw new Error("the stream broke"); } });
	out.ok.otherError = "returned";
} catch (error) {
	out.ok.otherError = error instanceof MimeLimitError ? "limit" : "thrown";
}
out.ok.plain = (await parseRawMime(encoder.encode(header + "\\r\\nhello\\r\\n").buffer)).text?.trim();
const replyTo = await parseRawMime(encoder.encode(header + "Reply-To: Desk <desk@b.example>\\r\\n\\r\\nhi\\r\\n").buffer);
out.ok.replyTo = replyTo.replyTo;
// Nested messages are never parsed a second time: they arrive as attachments.
const forwarded =
	header +
	multipart("b") +
	"--b\\r\\nContent-Type: text/plain\\r\\n\\r\\nsee below\\r\\n--b\\r\\nContent-Type: message/rfc822\\r\\n\\r\\n" +
	header +
	"\\r\\ninner\\r\\n--b--\\r\\n";
const parsedForward = await parseRawMime(encoder.encode(forwarded).buffer);
out.ok.forwardAttachments = parsedForward.attachments.map((attachment) => attachment.type);
out.ok.forwardText = parsedForward.text?.trim();
out.htmlText = htmlToReadableText("<style>a{}</style><p>Hi &amp; bye</p>").trim();
// Lowercasing "İ" adds a character; the closing tag is still found in the original.
out.htmlUnicode = htmlToReadableText("<p>İİİİ</p><STYLE>x{}</STYLE><p>after</p>").replace(/\\s+/g, " ").trim();
let started = performance.now();
out.htmlBomb = htmlToReadableText("<style>".repeat(30000) + "<p>hi</p>").includes("hi");
out.htmlBombMs = performance.now() - started;
started = performance.now();
htmlToReadableText("<".repeat(200000));
out.htmlAngleMs = performance.now() - started;
}
console.log(JSON.stringify(out));
`,
);
const bundle = join(directory, "entry.mjs");
await build({
	entryPoints: [entry],
	bundle: true,
	outfile: bundle,
	platform: "node",
	format: "esm",
	target: "node22",
	packages: "external",
	tsconfig: join(root, "tsconfig.json"),
	alias: { "@": join(root, "src") },
	logLevel: "silent",
});

test("hostile MIME is refused cheaply and legitimate mail still parses, inside a 128 MB heap", () => {
	const run = (mode) =>
		JSON.parse(
			execFileSync(process.execPath, ["--max-old-space-size=128", bundle, mode], {
				encoding: "utf8",
				timeout: 120_000,
			}),
		);
	const hostile = run("hostile");
	const out = { ...run("legit"), rejected: hostile.rejected, edge: hostile.edge, slowestMs: hostile.slowestMs };
	assert.ok(Object.keys(out.rejected).length >= 20, "every hostile shape ran");
	for (const [name, reason] of Object.entries(out.rejected)) {
		assert.match(String(reason), /^Message rejected:/, `${name} was not refused: ${reason}`);
		assert.equal(out.edge[name], reason, `${name} is refused at intake with the same reason`);
	}
	assert.ok(out.slowestMs < 5000, `the slowest hostile message took ${Math.round(out.slowestMs)} ms`);
	assert.equal(out.ok.attachments, 1);
	assert.ok(out.ok.flowedBytes > 2_300_000);
	// About 0.3 s; the quadratic decoder took about 23 s. The margin is for a loaded CI runner.
	assert.ok(out.ok.flowedMs < 3000, `39,000 flowed lines took ${Math.round(out.ok.flowedMs)} ms`);
	assert.equal(out.ok.flowedUnfolded, true);
	assert.equal(out.ok.folded, 1);
	assert.equal(out.ok.commented, 1);
	assert.equal(out.ok.shortLines, 1);
	assert.ok(out.ok.shortLinesMs < 10_000, `3 million base64 lines took ${Math.round(out.ok.shortLinesMs)} ms`);
	assert.deepEqual(out.ok.encodedForward, ["message/rfc822"]);
	assert.equal(out.ok.nested, "x");
	assert.ok(out.ok.nestedMs < 2000, `nested headers took ${Math.round(out.ok.nestedMs)} ms`);
	assert.equal(out.ok.digest, 25);
	assert.equal(out.ok.digestEdge, null, "a 25-post digest is not refused");
	assert.equal(out.ok.ninePlusTwoForwards, null);
	assert.match(out.ok.elevenFiles, /more than 10 attachments/);
	assert.equal(out.ok.otherError, "thrown");
	assert.equal(out.ok.plain, "hello");
	assert.equal(out.ok.replyTo, '"Desk" <desk@b.example>');
	assert.deepEqual(out.ok.forwardAttachments, ["message/rfc822"]);
	assert.equal(out.ok.forwardText, "see below");
	assert.equal(out.htmlText, "Hi & bye");
	assert.equal(out.htmlUnicode, "İİİİ after");
	assert.equal(out.htmlBomb, true);
	assert.ok(out.htmlBombMs < 1000, `unclosed <style> took ${Math.round(out.htmlBombMs)} ms`);
	assert.ok(out.htmlAngleMs < 1000, `unclosed < took ${Math.round(out.htmlAngleMs)} ms`);
});
