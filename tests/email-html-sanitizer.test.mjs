import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";
import { XSS_PAYLOADS, findActiveContent } from "./fixtures/xss-payloads.mjs";
import { NO_WRAP_SHAPES, RECEIPT_AMOUNT, RECEIPT_URL, receiptTableHtml } from "./fixtures/receipt-table.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-sanitizer-test-");
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { createEmailHtmlSanitizer } from "./src/app/(dashboard)/inbox/[messageId]/email-html-sanitizer-utils.ts";
			export { sanitizeStoredEmailHtml } from "./src/lib/email/stored-html-utils.ts";
			export { rootDirection, withRootDirection, wrappedRootDirection } from "./src/lib/email/root-direction-utils.ts";
			export { parseCssColour, isNearBlackNeutral, isUnreadableOnDark, paintsBackground } from "./src/components/messages/email-colour-utils.ts";
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
const {
	createEmailHtmlSanitizer,
	sanitizeStoredEmailHtml,
	rootDirection,
	withRootDirection,
	wrappedRootDirection,
	parseCssColour,
	isNearBlackNeutral,
	isUnreadableOnDark,
	paintsBackground,
} = await import(pathToFileURL(join(directory, "entry.mjs")).href);

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

test("dropFontFamily leaves inline font-family out on the DOM and changes nothing else", () => {
	// Outlook quotes the family; the declarations after it survive.
	const outlook = '<p style="font-family:&quot;Calibri&quot;,sans-serif;color:#1f497d;margin:0">Hi</p>';
	const dropped = sanitizeEmailHtml(outlook, { dropFontFamily: true }) ?? "";
	assert.doesNotMatch(dropped, /font-family|Calibri/);
	assert.match(dropped, /color: rgb\(31, 73, 125\)/);
	assert.match(dropped, /margin: 0px/);
	assert.equal(parse(dropped).textContent, "Hi");
	assert.match(sanitizeEmailHtml(outlook) ?? "", /font-family: (&quot;|")Calibri(&quot;|"), ?sans-serif/);
	// Visible text that merely looks like a style attribute is left alone.
	const text = '<p>Set style="font-family: Georgia" in your signature</p>';
	assert.equal(sanitizeEmailHtml(text, { dropFontFamily: true }), text);
	// Attribute boundaries are decided by the parser, never by text edits: a payload shaped to turn a title and
	// an alt into an image source with the family gone yields no new element, attribute or remote source.
	const payload =
		'<img title=" style=\';font-family:" alt="x"><span>AAA;</span><span title="\' src=https://evil.test/t.png data-x=">ok</span>';
	for (const options of [{ dropFontFamily: true }, { dropFontFamily: true, blockRemoteImages: true }]) {
		const output = sanitizeEmailHtml(payload, options) ?? "";
		const body = parse(output);
		const elements = Array.from(body.querySelectorAll("*"));
		// The source-less image may be dropped; nothing is added and nothing gains a source.
		assert.ok(elements.length <= 3 && elements.every((element) => /^(img|span)$/i.test(element.tagName)), output);
		assert.equal(body.querySelector("[src]"), null, output);
		// The host stays only as inert text inside the title attribute.
		assert.deepEqual(
			elements.flatMap((element) => Array.from(element.attributes).map((attribute) => attribute.name)).sort(),
			["title"],
		);
		assert.deepEqual(findActiveContent(output, parse), [], output);
		assert.equal(body.textContent, "AAA;ok");
	}
});

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

test("a receipt's amount cells keep what stops them wrapping, after both sanitizers", () => {
	const body = parse(sanitizeEmailHtml(sanitizeStoredEmailHtml(receiptTableHtml())));
	const amounts = [...body.querySelectorAll("td")].filter((cell) => cell.textContent === RECEIPT_AMOUNT);
	assert.equal(amounts.length, 2);
	assert.equal(amounts[0].hasAttribute("nowrap"), true);
	assert.match(amounts[0].getAttribute("style"), /white-space: nowrap/);
	assert.ok(
		[...body.querySelectorAll("table")].some((table) => /border-radius: 5px/.test(table.getAttribute("style"))),
	);
	assert.ok([...body.querySelectorAll("td")].some((cell) => /width: 100%/.test(cell.getAttribute("style") ?? "")));
	assert.equal(sanitizeEmailHtml("<table><tr><th nowrap>x</th></tr></table>").includes('<th nowrap="">'), true);
});

test("the reader sanitizer keeps the longhands browsers expand allowed shorthands into", () => {
	// Chromium reads `white-space: nowrap` as these two and `border: 0` as each side's width, style and colour; jsdom
	// does not expand shorthands, so the longhands are given as written.
	const output = sanitizeEmailHtml(
		'<table><tr><td style="white-space-collapse: collapse; text-wrap-mode: nowrap; border-top-width: 1px; border-top-style: solid; border-top-color: red; border-top-left-radius: 4px; overflow-wrap: break-word; text-decoration-line: none">$500.00</td></tr></table>',
	);
	for (const declaration of [
		"white-space-collapse: collapse",
		"text-wrap-mode: nowrap",
		"border-top: 1px solid red",
		"border-top-left-radius: 4px",
		"overflow-wrap: break-word",
		"text-decoration-line: none",
	]) {
		assert.ok(output.includes(declaration), `${declaration} in ${output}`);
	}
	// The frame draws the quote bar itself; mail that is sent keeps the sender's.
	const quote =
		'<blockquote style="margin-left: 0.8ex; border-left-width: 1px; border-left-style: solid">q</blockquote>';
	assert.equal(sanitizeEmailHtml(quote), '<blockquote style="margin-left: 0.8ex">q</blockquote>');
	assert.match(sanitizeEmailHtml(quote, { forOutgoing: true }), /border-left-width: 1px/);
	assert.equal(
		sanitizeEmailHtml('<p style="border-image-source: none; position: fixed; white-space-collapse: preserve">x</p>'),
		'<p style="white-space-collapse: preserve">x</p>',
	);
});

test("in the reader only a short table cell keeps its text on one line, and long words always break", () => {
	const unwrapped = /nowrap|text-wrap|white-space: pre;|overflow-wrap: normal|word-wrap: normal/;
	for (const [shape, html] of Object.entries(NO_WRAP_SHAPES)) {
		assert.doesNotMatch(sanitizeEmailHtml(html), unwrapped, shape);
		// Sent mail is the sender's to lay out.
		assert.match(sanitizeEmailHtml(html, { forOutgoing: true }), unwrapped, shape);
	}
	for (const value of ["nowrap", "pre"]) {
		assert.equal(
			sanitizeEmailHtml(`<div style="text-wrap-mode: wrap; white-space: ${value}">x</div>`),
			'<div style="text-wrap-mode: wrap">x</div>',
		);
	}
	assert.equal(
		sanitizeEmailHtml(
			'<table><tr><th nowrap style="text-wrap-mode: nowrap; overflow-wrap: anywhere">Amount paid</th></tr></table>',
		),
		'<table><tbody><tr><th nowrap="" style="text-wrap-mode: nowrap; overflow-wrap: anywhere">Amount paid</th></tr></tbody></table>',
	);
});

test("the reader marks text with a long word so it may break anywhere, but not amounts or outgoing mail", () => {
	const html = sanitizeStoredEmailHtml(receiptTableHtml());
	const body = parse(sanitizeEmailHtml(html, { linkify: true }));
	const marked = [...body.querySelectorAll("[data-kite-wrap]")];
	assert.deepEqual(
		marked.map((element) => element.getAttribute("data-kite-wrap")),
		["anywhere"],
	);
	assert.match(marked[0].textContent, /^Questions\? Visit https:/);
	assert.equal(marked[0].querySelector("a")?.getAttribute("href"), RECEIPT_URL);
	assert.doesNotMatch(sanitizeEmailHtml(html, { forOutgoing: true }), /data-kite-wrap/);
	assert.equal(
		sanitizeEmailHtml(`<table><tr><td>Total due: $1,234,567.89 on 2026-11-07</td></tr></table><p>${RECEIPT_URL}</p>`),
		`<table><tbody><tr><td>Total due: $1,234,567.89 on 2026-11-07</td></tr></tbody></table><p>${RECEIPT_URL}</p>`,
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

test("the outgoing sanitizer keeps an imported draft's inline-image references", () => {
	const html = '<p>Chart</p><img src="cid:chart-1@example.test" alt="chart">';
	assert.match(sanitizeEmailHtml(html, { forOutgoing: true }), /<img src="cid:chart-1@example\.test" alt="chart"/);
	// The reader rewrites cid: to attachment URLs first, so an unresolved one is dropped there.
	assert.doesNotMatch(sanitizeEmailHtml(html), /cid:/);
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

// Dark mode reads colours from each element's parsed inline style, never from the markup as text.
const NO_COLOURS = () => ({ background: false, unreadable: false, neutral: false });
function colourFacts(html, options = {}) {
	const colours = NO_COLOURS();
	const output = sanitizeEmailHtml(html, { colours, ...options });
	return { colours, output };
}

test("near-black text is marked for the frame and counted; its style is kept", () => {
	for (const value of ["black", "#000", "#222", "#333333", "rgb(34, 34, 34)", "rgba(0, 0, 0, .87)"]) {
		const { colours, output } = colourFacts(`<p style="margin: 0; color: ${value}">Hi</p>`);
		assert.deepEqual(colours, { background: false, unreadable: false, neutral: true }, value);
		assert.match(output, /<p [^>]*data-kite-text="neutral"/, value);
		assert.match(output, /style="[^"]*color:/, value);
	}
	// The marker sits on the element that declares the colour, not its children.
	const { output } = colourFacts('<div><p style="color:black">a</p><p>b</p></div>');
	assert.equal(output.match(/data-kite-text/g).length, 1);
});

test("text colours that stay unreadable on dark are counted, whatever the colour is called", () => {
	for (const value of [
		"#1F497D",
		"rgb(31, 73, 125)",
		"#555555",
		"dimgray",
		"darkslategray",
		"midnightblue",
		"indigo",
		"brown",
		"navy",
		"rebeccapurple",
	]) {
		const { colours, output } = colourFacts(`<p style="color: ${value}">Hi</p>`);
		assert.deepEqual(colours, { background: false, unreadable: true, neutral: false }, value);
		assert.doesNotMatch(output, /data-kite-text/, value);
	}
});

test("colours that read fine on dark are not counted or marked", () => {
	for (const value of [
		"white",
		"#e8eaed",
		"lightgray",
		"#8ab4f8",
		"rgb(200, 200, 200)",
		"gray",
		"var(--text)",
		"inherit",
	]) {
		const { colours, output } = colourFacts(`<p style="color: ${value}">Hi</p>`);
		assert.deepEqual(colours, NO_COLOURS(), value);
		assert.doesNotMatch(output, /data-kite-text/, value);
	}
});

test("a background colour is counted unless it is transparent", () => {
	for (const html of [
		'<div style="background-color: #fff">x</div>',
		'<div style="background: #f4f4f4">x</div>',
		'<table><tr><td style="background-color: rgb(0, 0, 0)">x</td></tr></table>',
	]) {
		assert.equal(colourFacts(html).colours.background, true, html);
	}
	for (const html of [
		'<div style="background-color: transparent">x</div>',
		'<div style="background-color: rgba(0, 0, 0, 0)">x</div>',
		'<div style="border-color: #fff">x</div>',
		"<div>x</div>",
	]) {
		assert.equal(colourFacts(html).colours.background, false, html);
	}
});

test("text that mentions styles is text: nothing is counted, marked or changed", () => {
	const probes = [
		'<pre>&lt;td style="color:#000"&gt;</pre>',
		'<p>style="color: rgb(31,73,125)"</p>',
		"<p>background-color: red; color: #1F497D</p>",
		'<p title="color: #1F497D">hover</p>',
		'<p>Favourite color: blue, bgcolor="#fff"</p>',
	];
	for (const html of probes) {
		const { colours, output } = colourFacts(html);
		assert.deepEqual(colours, NO_COLOURS(), html);
		assert.equal(output, sanitizeEmailHtml(html), `${html} comes out as without the colour pass`);
		assert.doesNotMatch(output, /data-kite-text/, html);
	}
	assert.match(colourFacts(probes[0]).output, /&lt;td style="color:#000"&gt;/);
});

test("nothing is marked or counted without a colours object, or for outgoing mail", () => {
	const html = '<p style="color: black">Hi</p>';
	assert.doesNotMatch(sanitizeEmailHtml(html), /data-kite-text/);
	const outgoing = NO_COLOURS();
	assert.doesNotMatch(sanitizeEmailHtml(html, { forOutgoing: true, colours: outgoing }), /data-kite-text/);
	assert.deepEqual(outgoing, NO_COLOURS());
});

test("a sender cannot forge the near-black marker", () => {
	const { colours, output } = colourFacts('<p data-kite-text="neutral" style="color: white">Hi</p>');
	assert.deepEqual(colours, NO_COLOURS());
	assert.doesNotMatch(output, /data-kite-text/);
});

test("colour parsing knows every CSS name, system text colours and the rgb forms", () => {
	const named = [
		"dimgray",
		"darkslategray",
		"midnightblue",
		"indigo",
		"brown",
		"rebeccapurple",
		"lightgoldenrodyellow",
		"mediumspringgreen",
		"whitesmoke",
		"yellowgreen",
	];
	for (const name of named) assert.ok(parseCssColour(name), name);
	assert.deepEqual(parseCssColour("DimGray").rgb, [105, 105, 105]);
	assert.deepEqual(parseCssColour("windowtext").rgb, [0, 0, 0]);
	assert.deepEqual(parseCssColour("#1F497D").rgb, [31, 73, 125]);
	assert.deepEqual(parseCssColour("#fff").rgb, [255, 255, 255]);
	assert.deepEqual(parseCssColour("rgb(31 73 125 / 50%)"), { rgb: [31, 73, 125], alpha: 0.5 });
	for (const value of ["", "inherit", "var(--x)", "hsl(0, 0%, 0%)", "notacolour"])
		assert.equal(parseCssColour(value), null, value);
	assert.equal(isNearBlackNeutral(parseCssColour("windowtext").rgb), true);
	assert.equal(isNearBlackNeutral(parseCssColour("#333").rgb), true);
	assert.equal(isNearBlackNeutral(parseCssColour("#555").rgb), false);
	assert.equal(isNearBlackNeutral(parseCssColour("#000040").rgb), false);
	assert.equal(isUnreadableOnDark(parseCssColour("#555").rgb), true);
	assert.equal(isUnreadableOnDark(parseCssColour("gray").rgb), false);
	assert.equal(paintsBackground("transparent"), false);
	assert.equal(paintsBackground("#fff"), true);
});

test("faint or transparent text is hidden on purpose: never marked, counted or revealed", () => {
	for (const value of [
		"transparent",
		"rgba(0, 0, 0, 0)",
		"rgb(0 0 0 / 0%)",
		"rgba(0, 0, 0, .05)",
		"rgba(31, 73, 125, .1)",
		"#00000000",
		"rgba(0, 0, 0, 0.39)",
	]) {
		const { colours, output } = colourFacts(`<p style="color: ${value}">Hidden preheader</p>`);
		assert.deepEqual(colours, NO_COLOURS(), value);
		assert.doesNotMatch(output, /data-kite-text/, value);
	}
	// Visible enough text still counts.
	assert.equal(colourFacts('<p style="color: rgba(0, 0, 0, .87)">x</p>').colours.neutral, true);
	assert.equal(colourFacts('<p style="color: rgba(0, 0, 0, .4)">x</p>').colours.neutral, true);
});

test("faint backgrounds and currentcolor do not make a mail count as designed", () => {
	for (const value of [
		"rgba(0, 0, 0, .05)",
		"rgba(255, 255, 255, 0.2)",
		"transparent",
		"currentcolor",
		"CurrentColor",
	]) {
		assert.equal(colourFacts(`<div style="background-color: ${value}">x</div>`).colours.background, false, value);
	}
	for (const value of ["rgba(0, 0, 0, .5)", "#f4f4f4", "white"]) {
		assert.equal(colourFacts(`<div style="background-color: ${value}">x</div>`).colours.background, true, value);
	}
	assert.equal(paintsBackground("currentcolor"), false);
	assert.equal(paintsBackground("rgba(0,0,0,.05)"), false);
});

const ROOT_CASES = [
	['<html dir="ltr"><body><div>x</div></body></html>', '<div dir="ltr"><div>x</div></div>'],
	['<html dir="ltr"><body dir="rtl"><div>x</div></body></html>', '<div dir="rtl"><div>x</div></div>'],
	['<html dir="rtl"><body dir="ltr"><div>x</div></body></html>', '<div dir="ltr"><div>x</div></div>'],
	['<html dir="RTL"><body><div>x</div></body></html>', '<div dir="rtl"><div>x</div></div>'],
	// `auto` is what the reader's frame does anyway, so it needs no wrapper; the body's `auto` also beats the html's `rtl`.
	['<body DIR="Auto"><div>x</div></body>', "<div>x</div>"],
	['<html dir="rtl"><body dir="auto"><div>x</div></body></html>', "<div>x</div>"],
	[
		'<html><head><title>T</title><style>p{}</style></head><body dir="rtl"><div>x</div></body></html>',
		'<div dir="rtl"><div>x</div></div>',
	],
	// An unusable body value does not hide the html element's declared one.
	['<html dir="rtl"><body dir="sideways"><div>x</div></body></html>', '<div dir="rtl"><div>x</div></div>'],
];
const ROOT_REJECTED = [
	'<html dir=" rtl"><body><div>x</div></body></html>',
	'<html dir="rtl "><body><div>x</div></body></html>',
	'<html dir="rtl; x"><body><div>x</div></body></html>',
	'<html dir="inherit"><body dir=""><div>x</div></body></html>',
	"<html dir='\"><script>x()</script>'><body><div>x</div></body></html>",
	'<html lang="ar" class="y" style="color:red" onload="x()"><body bgcolor="red" onload="x()"><div>x</div></body></html>',
	"<div>x</div>",
];

test("the direction declared on <html> or <body> survives storing, in one wrapper and nothing else", () => {
	for (const [html, expected] of ROOT_CASES) assert.equal(sanitizeStoredEmailHtml(html), expected, html);
	for (const html of ROOT_REJECTED) assert.equal(sanitizeStoredEmailHtml(html), "<div>x</div>", html);
	// A root tag after content is not a root: the mail is a fragment, and the rest of it is not made right to left.
	assert.equal(
		sanitizeStoredEmailHtml('<p>English reply</p><blockquote><body dir="rtl"><div>x</div></body></blockquote>'),
		"<p>English reply</p><blockquote><div>x</div></blockquote>",
	);
	assert.equal(
		sanitizeStoredEmailHtml('<p>English reply</p><html dir="rtl"><div>x</div></html>'),
		"<p>English reply</p><div>x</div>",
	);
	// An empty body stays empty, so the reader falls back to the text part instead of an empty frame.
	for (const html of ['<html dir="rtl"><body></body></html>', '<html dir="rtl"><body dir="ltr">\n  </body></html>']) {
		assert.ok(!sanitizeStoredEmailHtml(html).includes("<div"), html);
		assert.equal(sanitizeStoredEmailHtml(html).trim(), "", html);
	}
});

test("the direction declared on <html> or <body> survives the reader's sanitizer, in one wrapper and nothing else", () => {
	for (const [html, expected] of ROOT_CASES) assert.equal(sanitizeEmailHtml(html), expected, html);
	for (const html of ROOT_REJECTED) assert.equal(sanitizeEmailHtml(html), "<div>x</div>", html);
	// Mail the composer sanitizes for sending is left as it was.
	assert.equal(
		sanitizeEmailHtml('<html dir="rtl"><body dir="rtl"><div>x</div></body></html>', { forOutgoing: true }),
		"<div>x</div>",
	);
	// Sanitizing what was already stored adds no second wrapper, and a dir on an inner element is kept.
	const stored = sanitizeStoredEmailHtml('<html><body dir="rtl"><div dir="ltr">x</div></body></html>');
	assert.equal(stored, '<div dir="rtl"><div dir="ltr">x</div></div>');
	assert.equal(sanitizeEmailHtml(stored), stored);
	// An empty body stays empty here too.
	assert.equal(sanitizeEmailHtml('<html dir="rtl"><body></body></html>'), "");
	// The security properties stay: nothing else from the root tags, no script.
	assert.doesNotMatch(
		sanitizeEmailHtml(
			'<html dir="rtl" onload="x()"><body dir="rtl" onclick="x()"><script>x()</script><p>x</p></body></html>',
		),
		/script|onload|onclick/,
	);
});

test("rootDirection takes only the exact values, the body's before the html element's", () => {
	assert.equal(rootDirection("RTL", "ltr"), "rtl");
	assert.equal(rootDirection(undefined, "Auto"), "auto");
	assert.equal(rootDirection("", "ltr"), "ltr");
	assert.equal(rootDirection(" rtl", null), null);
	assert.equal(rootDirection("x", "y"), null);
});

test("withRootDirection wraps only for ltr and rtl, and never an empty body", () => {
	assert.equal(withRootDirection("<p>x</p>", "rtl"), '<div dir="rtl"><p>x</p></div>');
	assert.equal(withRootDirection("<p>x</p>", "ltr"), '<div dir="ltr"><p>x</p></div>');
	assert.equal(withRootDirection("<p>x</p>", "auto"), "<p>x</p>");
	assert.equal(withRootDirection("<p>x</p>", null), "<p>x</p>");
	assert.equal(withRootDirection("", "rtl"), "");
	assert.equal(withRootDirection(" \n", "rtl"), " \n");
});

test("wrappedRootDirection finds the wrapper only when it encloses the whole mail", () => {
	assert.equal(wrappedRootDirection('<div dir="rtl"><div>a</div><p>b</p></div>'), "rtl");
	assert.equal(wrappedRootDirection('<div dir="ltr"><div dir="rtl">a</div></div>\n'), "ltr");
	// A sender's own first div is not the wrapper unless it holds everything.
	assert.equal(wrappedRootDirection('<div dir="rtl">a</div><p>b</p>'), null);
	assert.equal(wrappedRootDirection('<div dir="rtl">a</div><div>b</div>'), null);
	assert.equal(wrappedRootDirection('<div dir="auto">a</div>'), null);
	assert.equal(wrappedRootDirection('<div dir="rtl" class="x">a</div>'), null);
	assert.equal(wrappedRootDirection('<p dir="rtl">a</p>'), null);
	assert.equal(wrappedRootDirection('<div dir="rtl"><div>a</div>'), null);
	assert.equal(wrappedRootDirection(""), null);
});
