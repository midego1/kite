import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-write-with-kite-utils-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		utils: fileURLToPath(import.meta.resolve("../src/components/compose/write-with-kite-utils.ts")),
		rich: fileURLToPath(import.meta.resolve("../src/components/compose/rich-text-utils.ts")),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	tsconfig: join(root, "tsconfig.json"),
});
const utils = await import(pathToFileURL(join(outDir, "utils.mjs")).href);
const rich = await import(pathToFileURL(join(outDir, "rich.mjs")).href);

const SIGNATURE = '<div data-kite-signature="1"><br><br>Alex<br>CFO</div>';

test("the signature block is split off and always kept after a new body", () => {
	assert.deepEqual(utils.splitSignature(`<div>Hello</div>${SIGNATURE}`), {
		body: "<div>Hello</div>",
		signature: SIGNATURE,
	});
	const legacy = '<div data-mailflare-signature="1">Old</div>';
	assert.deepEqual(utils.splitSignature(`<div>Hi</div>${legacy}`), { body: "<div>Hi</div>", signature: legacy });
	assert.deepEqual(utils.splitSignature("<div>No signature</div>"), { body: "<div>No signature</div>", signature: "" });
	assert.equal(utils.replaceBody(`<div>Old text</div>${SIGNATURE}`, "<div>New</div>"), `<div>New</div>${SIGNATURE}`);
	assert.equal(utils.replaceBody("<div>Old</div>", "<div>New</div>"), "<div>New</div>");
});

test("model text becomes escaped HTML with paragraphs and lists", () => {
	assert.equal(
		utils.composeTextToHtml("Hi <Sam> & co,\n\nLine one\nline two\n\n- Agenda\n- Budget\n\n1. First\n2) Second"),
		"<div>Hi &lt;Sam&gt; &amp; co,</div><div><br></div><div>Line one<br>line two</div><div><br></div><ul><li>Agenda</li><li>Budget</li></ul><div><br></div><ol><li>First</li><li>Second</li></ol>",
	);
	assert.equal(utils.composeTextToHtml("• One\n• Two"), "<ul><li>One</li><li>Two</li></ul>");
	assert.equal(utils.composeTextToHtml("\n\n  \n"), "");
	assert.equal(
		utils.composeTextToHtml('<img src=x onerror="alert(1)">'),
		"<div>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</div>",
	);
});

test("a translation keeps the original below it in a quote block", () => {
	assert.equal(
		utils.withOriginalBelow("<div>Hallo</div>", "<div>Hello</div>"),
		"<div>Hallo</div><blockquote><div>Hello</div></blockquote>",
	);
});

test("formatting a plain-text rewrite would drop is detected", () => {
	for (const html of [
		'<a href="https://x.test">x</a>',
		"<b>x</b>",
		"<strong>x</strong>",
		'<img src="x">',
		"<em>x</em>",
	])
		assert.equal(utils.hasRichFormatting(html), true, html);
	assert.equal(utils.hasRichFormatting("<div>Plain<br>text</div><blockquote>q</blockquote>"), false);
});

test("streamed NDJSON is read line by line, keeping a partial line for the next chunk", () => {
	const first = utils.parseComposeEvents('{"type":"text","text":"Hel"}\n{"type":"text","te');
	assert.deepEqual(first.events, [{ type: "text", text: "Hel" }]);
	const second = utils.parseComposeEvents(
		`${first.rest}xt":"lo"}\nnot json\n{"type":"done","text":"Hello","warnings":[]}\n`,
	);
	assert.deepEqual(second.events, [
		{ type: "text", text: "lo" },
		{ type: "done", text: "Hello", warnings: [] },
	]);
	assert.equal(second.rest, "");
});

test("Translate offers the browser's language first when it is not already listed", () => {
	assert.deepEqual(utils.translateLanguages("en-GB"), ["English", "Dutch", "German", "French", "Spanish"]);
	assert.deepEqual(utils.translateLanguages("it-IT"), ["Italian", "English", "Dutch", "German", "French", "Spanish"]);
	assert.deepEqual(utils.translateLanguages(undefined), ["English", "Dutch", "German", "French", "Spanish"]);
	assert.match(utils.warningText("removed_link"), /link/);
	assert.equal(utils.warningText("other"), "other");
});

test("a new message starts with an empty body line before the signature, so typing never lands inside it", () => {
	const fresh = rich.applyMailboxSignatureHtml("", "", "Alex");
	assert.equal(fresh, '<div><br></div><div data-kite-signature="1"><br><br>Alex</div>');
	assert.deepEqual(utils.splitSignature(fresh), {
		body: "<div><br></div>",
		signature: '<div data-kite-signature="1"><br><br>Alex</div>',
	});
	assert.equal(
		rich.applyMailboxSignatureHtml(fresh, "Alex", "Sam"),
		'<div><br></div><div data-kite-signature="1"><br><br>Sam</div>',
	);
	assert.equal(
		rich.applyMailboxSignatureHtml("<div>Hi</div>", "", "Alex"),
		'<div>Hi</div><div data-kite-signature="1"><br><br>Alex</div>',
	);
	assert.equal(rich.applyMailboxSignatureHtml("", "", ""), "");
});
