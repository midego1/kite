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
import { inboundAttachmentLimitReasonFromRaw } from "${root}/src/lib/email/inbound-attachments";
import { htmlToReadableText } from "${root}/src/lib/email/reply-content-utils";

const encoder = new TextEncoder();
const header = "From: a@b.example\\r\\nTo: c@d.example\\r\\nSubject: x\\r\\n";
const multipart = (boundary) => \`Content-Type: multipart/mixed; boundary="\${boundary}"\\r\\n\\r\\n\`;
const hostile = {
	blankLines: header + "\\r\\n" + "\\r\\n".repeat(512 * 1024),
	shortLines: header + "\\r\\n" + "a\\r\\n".repeat(262144),
	spaceLines: header + "\\r\\n" + " \\r\\n".repeat(262144),
	textLines: header + "\\r\\n" + ("a".repeat(78) + "\\r\\n").repeat(262144),
	bareLfLines: header + "\\n" + "a\\n".repeat(262144),
	// A line that looks like a boundary must not leave the lines after it uncounted.
	fakeBoundaryLines: header + "\\r\\n--x\\r\\n" + "a\\r\\n".repeat(262144),
	// Lines in a part's header block count too.
	partHeaderLines: header + multipart("b") + "--b\\r\\n" + "X-A: 1\\r\\n".repeat(262144),
	nestedMessages: header + "Content-Type: message/rfc822\\r\\n\\r\\n".repeat(5000),
	parts: header + multipart("b") + "--b\\r\\nContent-Type: text/plain\\r\\n\\r\\nx\\r\\n".repeat(20000),
	headerBlock: "X-Pad: " + "a".repeat(200 * 1024) + "\\r\\n\\r\\nbody",
	deepMultipart:
		header +
		Array.from({ length: 30 }, (_, depth) => \`Content-Type: multipart/mixed; boundary="b\${depth}"\\r\\n\\r\\n--b\${depth}\\r\\n\`).join("") +
		"Content-Type: text/plain\\r\\n\\r\\nx\\r\\n",
};
const out = { rejected: {}, edge: {}, slowestMs: 0, ok: {} };
for (const [name, text] of Object.entries(hostile)) {
	const raw = encoder.encode(text).buffer;
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
// A 25 MB-class base64 attachment is about 340,000 short lines and must still parse.
const pdf =
	multipart("b") +
	"--b\\r\\nContent-Type: application/pdf\\r\\nContent-Transfer-Encoding: base64\\r\\nContent-Disposition: attachment; filename=a.pdf\\r\\n\\r\\n";
const legit = header + pdf + ("QUFB".repeat(19) + "\\r\\n").repeat(340000) + "--b--\\r\\n";
out.ok.attachments = (await parseRawMime(encoder.encode(legit).buffer)).attachments.length;
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
let started = performance.now();
out.htmlBomb = htmlToReadableText("<style>".repeat(30000) + "<p>hi</p>").includes("hi");
out.htmlBombMs = performance.now() - started;
started = performance.now();
htmlToReadableText("<".repeat(200000));
out.htmlAngleMs = performance.now() - started;
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
	const out = JSON.parse(
		execFileSync(process.execPath, ["--max-old-space-size=128", bundle], { encoding: "utf8", timeout: 120_000 }),
	);
	for (const [name, reason] of Object.entries(out.rejected)) {
		assert.match(String(reason), /^Message rejected:/, `${name} was not refused: ${reason}`);
		assert.equal(out.edge[name], reason, `${name} is refused at intake with the same reason`);
	}
	assert.ok(out.slowestMs < 5000, `the slowest hostile message took ${Math.round(out.slowestMs)} ms`);
	assert.equal(out.ok.attachments, 1);
	assert.equal(out.ok.plain, "hello");
	assert.equal(out.ok.replyTo, '"Desk" <desk@b.example>');
	assert.deepEqual(out.ok.forwardAttachments, ["message/rfc822"]);
	assert.equal(out.ok.forwardText, "see below");
	assert.equal(out.htmlText, "Hi & bye");
	assert.equal(out.htmlBomb, true);
	assert.ok(out.htmlBombMs < 1000, `unclosed <style> took ${Math.round(out.htmlBombMs)} ms`);
	assert.ok(out.htmlAngleMs < 1000, `unclosed < took ${Math.round(out.htmlAngleMs)} ms`);
});
