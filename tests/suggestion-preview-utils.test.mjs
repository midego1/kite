import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-suggestion-preview-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/components/agent/suggestion-preview-utils.ts")],
	outfile: join(bundleDirectory, "preview.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	absWorkingDir: root,
	logLevel: "silent",
});
const { PREVIEW_HTML_LIMIT, bodyText, hoversWith, previewExcerpt } = await import(
	pathToFileURL(join(bundleDirectory, "preview.mjs")).href
);

test("only a mouse or a pen hovers; a finger keeps the row opening the message", () => {
	assert.equal(hoversWith("mouse"), true);
	assert.equal(hoversWith("pen"), true);
	assert.equal(hoversWith("touch"), false);
	assert.equal(hoversWith(""), false);
});

test("the excerpt is plain text: quotes, signatures and blank runs go, and it is cut at a word", () => {
	assert.equal(previewExcerpt(null), "");
	assert.equal(previewExcerpt("  Hello   there \n\n\n\nSecond   line  "), "Hello there\n\nSecond line");
	assert.equal(previewExcerpt("Thanks!\n> old quoted text\n> more\nSee you"), "Thanks!\nSee you");
	assert.equal(previewExcerpt("Real text\n-- \nSender Name\nPhone 123"), "Real text");
	const long = `${"word ".repeat(100)}end`;
	const cut = previewExcerpt(long, 50);
	assert.ok(cut.endsWith("…"));
	assert.ok(cut.length <= 51);
	assert.ok(!cut.slice(0, -1).endsWith("wor"));
	assert.equal(previewExcerpt("short", 50), "short");
});

test("a body reads as its stored text, else as the text of its (capped) HTML", () => {
	const toText = (html) => `text of ${html}`;
	assert.equal(bodyText({ textBody: "plain", htmlBody: "<p>html</p>" }, toText), "plain");
	assert.equal(bodyText({ textBody: "  ", htmlBody: "<p>html</p>" }, toText), "text of <p>html</p>");
	assert.equal(bodyText({ textBody: null, htmlBody: null }, toText), "");
	assert.equal(bodyText(null, toText), "");
	const seen = [];
	bodyText({ htmlBody: "x".repeat(PREVIEW_HTML_LIMIT + 500) }, (html) => (seen.push(html.length), ""));
	assert.deepEqual(seen, [PREVIEW_HTML_LIMIT]);
});
