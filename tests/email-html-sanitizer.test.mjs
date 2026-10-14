import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { XSS_PAYLOADS, findActiveContent } from "./fixtures/xss-payloads.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-sanitizer-test-");
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { createEmailHtmlSanitizer } from "./src/app/(dashboard)/inbox/[messageId]/email-html-sanitizer-utils.ts";
			export { sanitizeStoredEmailHtml } from "./src/lib/email/stored-html-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "email-html-sanitizer-test-entry.ts",
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
const { createEmailHtmlSanitizer, sanitizeStoredEmailHtml } = await import(
	pathToFileURL(join(directory, "entry.mjs")).href
);

const { window } = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://kite.example/inbox" });
const sanitizeEmailHtml = createEmailHtmlSanitizer(window);

function parse(html) {
	return new window.DOMParser().parseFromString(`<!doctype html><body>${html}`, "text/html").body;
}

for (const [index, payload] of XSS_PAYLOADS.entries()) {
	test(`the reader sanitizer makes payload ${index + 1} inert: ${payload.slice(0, 60)}`, () => {
		for (const options of [{}, { forOutgoing: true }, { blockRemoteImages: true }]) {
			const output = sanitizeEmailHtml(payload, options) ?? "";
			assert.deepEqual(findActiveContent(output, parse), [], output);
			// A second pass must not turn the output into something else (mutation XSS).
			assert.deepEqual(findActiveContent(sanitizeEmailHtml(output, options) ?? "", parse), []);
		}
	});

	test(`the stored-HTML sanitizer makes payload ${index + 1} inert: ${payload.slice(0, 60)}`, () => {
		const output = sanitizeStoredEmailHtml(payload) ?? "";
		assert.deepEqual(findActiveContent(output, parse), [], output);
		assert.equal(sanitizeStoredEmailHtml(output) ?? "", output, "stored sanitizing is idempotent");
		// The reader runs on top of stored HTML; the pair must stay inert too.
		assert.deepEqual(findActiveContent(sanitizeEmailHtml(output) ?? "", parse), []);
	});
}

test("the reader sanitizer keeps ordinary formatting and drops script text", () => {
	assert.equal(
		sanitizeEmailHtml("<p>Hello <b>reader</b></p><script>window.parent.__pwned = true</script>"),
		"<p>Hello <b>reader</b></p>",
	);
	assert.equal(sanitizeEmailHtml("<center>Centred</center>"), "Centred");
	assert.equal(sanitizeEmailHtml("<form>secret<input value=x></form><p>after</p>"), "<p>after</p>");
	assert.equal(sanitizeEmailHtml("<strike>gone</strike>"), "<strike>gone</strike>");
	assert.equal(sanitizeEmailHtml(""), null);
	assert.equal(sanitizeEmailHtml(null), null);
});

test("the reader sanitizer applies per-tag attributes and the style allowlist", () => {
	assert.equal(sanitizeEmailHtml('<p width="5" title="t">x</p>'), '<p title="t">x</p>');
	assert.equal(
		sanitizeEmailHtml('<table><tr><td colspan="2">x</td></tr></table>'),
		'<table><tbody><tr><td colspan="2">x</td></tr></tbody></table>',
	);
	assert.equal(
		sanitizeEmailHtml('<p style="position: fixed; color: red; background-image: url(https://t.example/p.png)">x</p>'),
		'<p style="color: red">x</p>',
	);
	assert.equal(
		sanitizeEmailHtml('<p style="font-family: Arial">x</p>'),
		'<p style="font-family: Arial, var(--font-geist-sans), system-ui, sans-serif">x</p>',
	);
	assert.equal(
		sanitizeEmailHtml('<p style="font-family: Arial">x</p>', { forOutgoing: true }),
		'<p style="font-family: Arial">x</p>',
	);
	assert.equal(
		sanitizeEmailHtml('<div data-kite-signature="1" data-other="1">sig</div>'),
		'<div data-kite-signature="1">sig</div>',
	);
});

test("the reader sanitizer opens safe links in a new tab and strips unsafe ones", () => {
	assert.equal(
		sanitizeEmailHtml('<a href="https://ok.example/a">a</a>'),
		'<a href="https://ok.example/a" target="_blank" rel="noopener noreferrer">a</a>',
	);
	assert.equal(
		sanitizeEmailHtml('<a href="mailto:a@example.com">m</a>'),
		'<a href="mailto:a@example.com" target="_blank" rel="noopener noreferrer">m</a>',
	);
	assert.equal(sanitizeEmailHtml('<a href="ftp://ok.example/a">f</a>'), "<a>f</a>");
	assert.equal(sanitizeEmailHtml('<a href="/relative">r</a>', { forOutgoing: true }), "<a>r</a>");
});

test("the reader sanitizer holds remote images and keeps local and inline ones", () => {
	const stats = { blockedRemoteImages: 0 };
	const html =
		'<img src="https://t.example/p.png" alt="remote"><img src="/api/messages/m/attachments/a?preview=1" alt="inline"><img src="data:image/png;base64,AAAA" alt="data"><img src="data:image/svg+xml;base64,AAAA" alt="svg">';
	const output = sanitizeEmailHtml(html, { blockRemoteImages: true, stats });
	assert.equal(stats.blockedRemoteImages, 1);
	assert.doesNotMatch(output, /t\.example|svg\+xml/);
	assert.match(output, /alt="inline" loading="lazy" referrerpolicy="no-referrer"/);
	assert.match(output, /alt="data"/);
	assert.match(
		sanitizeEmailHtml(html),
		/src="https:\/\/t\.example\/p\.png" alt="remote" loading="lazy" referrerpolicy="no-referrer"/,
	);
	assert.doesNotMatch(sanitizeEmailHtml(html, { forOutgoing: true }), /\/api\/messages\//);
	assert.doesNotMatch(sanitizeEmailHtml('<img src="http://t.example/p.png">', { forOutgoing: true }), /<img/);
});

test("the reader sanitizer spaces the 'On … wrote:' line above a quote", () => {
	assert.equal(
		sanitizeEmailHtml("<div>On Mon, a@example.com wrote:</div><blockquote>old</blockquote>"),
		'<div style="margin-top: 1.4em; padding-bottom: 0.6em">On Mon, a@example.com wrote:</div><blockquote>old</blockquote>',
	);
});

test("stored HTML keeps layout, classes, Kite's quote marker and inline-image references", () => {
	const quote = '<div class="kite-quote" data-kite-quote="1"><blockquote type="cite">old</blockquote></div>';
	assert.equal(sanitizeStoredEmailHtml(quote), quote);
	const layout =
		'<table width="600" bgcolor="#ffffff" align="center" cellpadding="0"><tr><td class="hero" style="padding:8px;background:url(https://t.example/bg.png)"><img src="cid:image001.png@01DA" alt="logo" width="120"></td></tr></table>';
	const stored = sanitizeStoredEmailHtml(layout);
	assert.match(stored, /<table width="600" bgcolor="#ffffff" align="center" cellpadding="0">/);
	assert.match(stored, /class="hero" style="padding:8px;background:url\(https:\/\/t\.example\/bg\.png\)"/);
	assert.match(stored, /<img src="cid:image001\.png@01DA" alt="logo" width="120">/);
	assert.match(
		sanitizeStoredEmailHtml('<font color="red" face="Arial">x</font>'),
		/<font color="red" face="Arial">x<\/font>/,
	);
});

test("stored HTML drops documents' head, styles, comments and active content", () => {
	assert.equal(
		sanitizeStoredEmailHtml(
			"<html><head><title>T</title><style>p{color:red}</style><meta charset=utf-8></head><body><!-- note --><p>Body</p><script>x()</script></body></html>",
		),
		"<p>Body</p>",
	);
	assert.equal(sanitizeStoredEmailHtml("<head><meta charset=utf-8><p>No body tag</p>"), "<p>No body tag</p>");
	assert.equal(sanitizeStoredEmailHtml('<p style="width:expression(alert(1))">x</p>'), "<p>x</p>");
	assert.equal(
		sanitizeStoredEmailHtml("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>"),
		"<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
	);
	assert.equal(
		sanitizeStoredEmailHtml('<a title="&quot;><script>x</script>" href="https://ok.example/?a=1&amp;b=2">x</a>'),
		'<a title="&quot;&gt;&lt;script&gt;x&lt;/script&gt;" href="https://ok.example/?a=1&amp;b=2">x</a>',
	);
	assert.equal(sanitizeStoredEmailHtml("<custom-tag>kept text</custom-tag><button>Press</button>"), "kept textPress");
	assert.equal(sanitizeStoredEmailHtml(""), null);
	assert.equal(sanitizeStoredEmailHtml(undefined), null);
});
