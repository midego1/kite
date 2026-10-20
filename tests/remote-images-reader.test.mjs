import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-remote-images-reader-");
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `export { createEmailHtmlSanitizer } from "./src/app/(dashboard)/inbox/[messageId]/email-html-sanitizer-utils.ts";`,
		resolveDir: root,
		sourcefile: "remote-images-reader-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	absWorkingDir: root,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const { createEmailHtmlSanitizer } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const ORIGIN = "https://kite.example.com";
const { window } = new JSDOM("<!doctype html><html><body></body></html>", { url: `${ORIGIN}/inbox` });
const sanitize = createEmailHtmlSanitizer(window);
const proxied = (url, message = "m1") => `/api/remote-images?${new URLSearchParams({ message, url })}`;

function sources(html) {
	const body = new window.DOMParser().parseFromString(`<!doctype html><body>${html}`, "text/html").body;
	return Array.from(body.querySelectorAll("img"), (img) => img.getAttribute("src"));
}

const MAIL = [
	'<img src="https://cdn.example.com/logo.png?a=1&amp;b=2" alt="logo">',
	'<img src="http://cdn.example.com/plain.gif">',
	'<img src="//cdn.example.com/relative.png">',
	'<img src="/api/messages/m1/attachments/a1?inline=1">',
	'<img src="data:image/png;base64,iVBORw0KGgo=">',
	'<img src="/local.png">',
	'<a href="https://cdn.example.com/page">link</a>',
].join("");

test("blocked remote images are dropped and never point at the proxy", () => {
	const stats = { blockedRemoteImages: 0 };
	const html = sanitize(MAIL, { blockRemoteImages: true, stats, proxyRemoteImagesFor: "m1" });
	assert.equal(stats.blockedRemoteImages, 4);
	assert.doesNotMatch(html, /remote-images|cdn\.example\.com\/(?:logo|plain|relative)/);
	assert.deepEqual(sources(html), ["/api/messages/m1/attachments/a1?inline=1", "data:image/png;base64,iVBORw0KGgo="]);
});

test("allowed remote images load through the same-origin proxy for the message being read", () => {
	const html = sanitize(MAIL, { blockRemoteImages: false, proxyRemoteImagesFor: "m1" });
	assert.deepEqual(sources(html), [
		proxied("https://cdn.example.com/logo.png?a=1&b=2"),
		proxied("http://cdn.example.com/plain.gif"),
		proxied("https://cdn.example.com/relative.png"),
		"/api/messages/m1/attachments/a1?inline=1",
		"data:image/png;base64,iVBORw0KGgo=",
		"/local.png",
	]);
	assert.match(html, /href="https:\/\/cdn\.example\.com\/page"/);
	assert.match(html, /referrerpolicy="no-referrer"/);
});

test("each conversation message proxies with its own id", () => {
	const html = sanitize('<img src="https://cdn.example.com/a.png">', { proxyRemoteImagesFor: "other-message" });
	assert.deepEqual(sources(html), [proxied("https://cdn.example.com/a.png", "other-message")]);
});

test("without a message id, and for outgoing mail, image URLs stay as they are", () => {
	assert.deepEqual(sources(sanitize('<img src="https://cdn.example.com/a.png">')), ["https://cdn.example.com/a.png"]);
	assert.deepEqual(
		sources(sanitize('<img src="https://cdn.example.com/a.png">', { forOutgoing: true, proxyRemoteImagesFor: "m1" })),
		["https://cdn.example.com/a.png"],
	);
});

test("unsafe image URLs are still removed rather than proxied", () => {
	const html = sanitize(
		'<img src="javascript:alert(1)"><img src="file:///etc/passwd"><img src="data:image/svg+xml;base64,PHN2Zz4=">',
		{ proxyRemoteImagesFor: "m1" },
	);
	assert.deepEqual(sources(html), []);
});
