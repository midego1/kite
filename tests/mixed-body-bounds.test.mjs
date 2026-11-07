import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

// A text part beside an HTML part is rendered in both formats. The large cases run in a child process with a 128 MB
// heap, so a bound that stops working shows up as a failed child instead of slowing the whole test run.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-mixed-body-bounds-");
after(() => rmSync(directory, { recursive: true, force: true }));

const entry = join(directory, "entry.ts");
writeFileSync(
	entry,
	`
export { buildSnippet, parseRawMime } from "${root}/src/lib/email/parse";
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
const { parseRawMime } = await import(pathToFileURL(bundle).href);
const MAX_BODY_CONVERSION_COST = 6_000_000;

const messageHelpers = `
const header = "From: a@example.com\\r\\nTo: b@example.com\\r\\nSubject: x\\r\\nMIME-Version: 1.0\\r\\n";
const multipart = (kind, parts) =>
	header + 'Content-Type: multipart/' + kind + '; boundary="B"\\r\\n\\r\\n' +
	parts.map((part) => "--B\\r\\n" + part + "\\r\\n").join("") + "--B--\\r\\n";
const mixed = (...parts) => multipart("mixed", parts);
const alternative = (...parts) => multipart("alternative", parts);
const text = (body) => "Content-Type: text/plain\\r\\n\\r\\n" + body;
const html = (body) => "Content-Type: text/html\\r\\n\\r\\n" + body;
const lines = (line, count) => (line + "\\r\\n").repeat(count);
const encode = (message) => new TextEncoder().encode(message).buffer;
`;

const worker = join(directory, "worker.mjs");
writeFileSync(
	worker,
	`
import { buildSnippet, parseRawMime } from ${JSON.stringify(pathToFileURL(bundle).href)};
${messageHelpers}
const hello = html("<p>hi</p>");
const shapes = {
	brackets: () => mixed(hello, text(lines("<".repeat(52), 149_000))),
	longBrackets: () => mixed(hello, text(lines("<".repeat(200), 39_000))),
	largeBrackets: () => mixed(hello, text(lines("<".repeat(600), 39_000))),
	links: () => mixed(hello, text(lines("http://a.b/ ".repeat(13), 149_000))),
	longLinks: () => mixed(hello, text(lines("http://a.b/ ".repeat(50), 39_000))),
	htmlBrackets: () => mixed(text("hi"), html(lines("<".repeat(158), 149_000))),
	longHtmlBrackets: () => mixed(text("hi"), html(lines("<".repeat(600), 39_000))),
	plainBesideHtml: () => mixed(html(lines("a".repeat(160), 20_000)), text(lines("b".repeat(160), 12_000))),
	largerPlainBesideHtml: () => mixed(html(lines("a".repeat(160), 37_000)), text(lines("b".repeat(160), 37_000))),
	alternativeBrackets: () => alternative(text(lines("<".repeat(52), 149_000)), hello),
	underLimit: () => mixed(hello, text("x".repeat(2_000_000))),
	spacedHtml: () => mixed(text("hi"), html("a ".repeat(2_000_000))),
	returnsHtml: () => mixed(text("hi"), html("a\\r".repeat(3_000_000))),
	wordsHtml: () => mixed(text("hi"), html("word12 ".repeat(1_500_000))),
	separatorsHtml: () => mixed(text("hi"), html("\\u2028".repeat(5_000_000))),
	tabsHtml: () => mixed(text("hi"), html("a\\t".repeat(7_900_000))),
	spacedHtmlAtLimit: () => mixed(text("hi"), html("a ".repeat(599_000))),
	returnsHtmlAtLimit: () => mixed(text("hi"), html("a\\r".repeat(599_000))),
	wordsHtmlAtLimit: () => mixed(text("hi"), html("word12 ".repeat(399_000))),
	separatorsHtmlAtLimit: () => mixed(text("hi"), html("\\u2028".repeat(599_000))),
	placeholdersHtml: () => mixed(text("hi"), html("a\\u0001".repeat(2_000_000))),
	onlyPlaceholdersHtml: () => mixed(text("hi"), html("\\u0001".repeat(4_000_000))),
	referencesHtml: () => mixed(text("hi"), html("&amp;lt".repeat(1_200_000))),
	unknownReferencesHtml: () => mixed(text("hi"), html("&amp;a;".repeat(1_300_000))),
	numericReferencesHtml: () => mixed(text("hi"), html("&amp;#60;".repeat(1_000_000))),
	shortReferencesHtml: () => mixed(text("hi"), html("&a;".repeat(2_000_000))),
	placeholdersHtmlAtLimit: () => mixed(text("hi"), html("a\\u0001".repeat(599_000))),
	referencesHtmlAtLimit: () => mixed(text("hi"), html("&amp;lt".repeat(193_000))),
	unknownReferencesHtmlAtLimit: () => mixed(text("hi"), html("&amp;a;".repeat(193_000))),
	numericReferencesHtmlAtLimit: () => mixed(text("hi"), html("&amp;#60;".repeat(181_000))),
	placeholderDigitsHtml: () => mixed(text("hi"), html("\\u00011a".repeat(1_410_000))),
	closingReturnsHtml: () => mixed(text("hi"), html("/p\\r".repeat(1_410_000))),
	doubledPlaceholdersHtml: () => mixed(text("hi"), html("xx\\u0001".repeat(1_450_000))),
	placeholderPunctuationHtml: () => mixed(text("hi"), html("a\\u0001/-a".repeat(1_190_000))),
	spacedText: () => mixed(hello, text("word12 ".repeat(1_600_000))),
};

const out = {};
for (const [name, message] of Object.entries(shapes)) {
	const started = performance.now();
	const parsed = await parseRawMime(encode(message()));
	const snippet = buildSnippet(parsed.text, parsed.html);
	out[name] = {
		text: parsed.text?.length ?? 0,
		html: parsed.html?.length ?? 0,
		snippet: snippet.length,
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

test("large text and HTML parts are rendered within a 128 MB heap", () => {
	const output = execFileSync(process.execPath, ["--max-old-space-size=128", worker], {
		encoding: "utf8",
		env: childEnv,
		timeout: 300_000,
	});
	const results = JSON.parse(output);
	assert.equal(Object.keys(results).length, 35);
	for (const [name, result] of Object.entries(results)) assert.ok(result.ms < 60_000, `${name}: ${result.ms} ms`);
	// Over the limit: the parts keep to their own format.
	assert.equal(results.brackets.html, "<p>hi</p>".length);
	assert.equal(results.htmlBrackets.text, 2);
	for (const name of [
		"spacedHtml",
		"returnsHtml",
		"wordsHtml",
		"separatorsHtml",
		"tabsHtml",
		"placeholdersHtml",
		"onlyPlaceholdersHtml",
		"referencesHtml",
		"unknownReferencesHtml",
		"numericReferencesHtml",
		"shortReferencesHtml",
		"placeholderDigitsHtml",
		"closingReturnsHtml",
		"doubledPlaceholdersHtml",
		"placeholderPunctuationHtml",
	]) {
		assert.equal(results[name].text, 2, name);
	}
	// Under it: both bodies hold both parts.
	for (const name of [
		"spacedHtmlAtLimit",
		"returnsHtmlAtLimit",
		"wordsHtmlAtLimit",
		"separatorsHtmlAtLimit",
		"placeholdersHtmlAtLimit",
		"referencesHtmlAtLimit",
		"unknownReferencesHtmlAtLimit",
		"numericReferencesHtmlAtLimit",
	]) {
		assert.ok(results[name].text > 2, name);
	}
	// Cut to the decoded text limit first, a text part of links or words is converted again.
	assert.ok(results.links.html > 2_000_000);
	assert.ok(results.spacedText.html > 2_000_000);
	assert.ok(results.plainBesideHtml.text > 5_000_000);
	assert.ok(results.plainBesideHtml.html > 5_000_000);
	assert.ok(results.underLimit.html > 2_000_000);
	// Cut to 2 MiB of text and 4 MiB of HTML, together still over the limit.
	assert.ok(results.largerPlainBesideHtml.text < 2_100_000);
	assert.ok(results.largerPlainBesideHtml.html < 4_200_000);
	// multipart/alternative renders one representation of each format, as before; only the cut text has the note.
	assert.equal(results.alternativeBrackets.html, "<p>hi</p>".length);
	assert.equal(results.alternativeBrackets.text, 38_836 * 53 + 114);
});

const parts = new Function(`${messageHelpers}return { alternative, encode, html, mixed, text };`)();

test("text and HTML parts stay in order and in both bodies under the limit", async () => {
	const parsed = await parseRawMime(
		parts.encode(parts.mixed(parts.html("<p>one</p>"), parts.text("two <3"), parts.html("<p>three</p>"))),
	);
	assert.match(parsed.html, /<p>one<\/p>[^]*two &lt;3[^]*<p>three<\/p>/);
	assert.match(parsed.text, /one[^]*two <3[^]*three/);
});

test("over the limit each format holds only its own parts, in order", async () => {
	const large = "<".repeat(Math.ceil(MAX_BODY_CONVERSION_COST / 9) + 1);
	const parsed = await parseRawMime(
		parts.encode(
			parts.mixed(parts.html("<p>one</p>"), parts.text(large), parts.html("<p>three</p>"), parts.text("four")),
		),
	);
	assert.equal(parsed.html, "<p>one</p>\n<p>three</p>");
	assert.equal(parsed.text.length, large.length + "\nfour".length);
	assert.ok(parsed.text.endsWith("<\nfour"));
});

test("a body in one format is never affected by the limit", async () => {
	const large = "<".repeat(MAX_BODY_CONVERSION_COST / 6);
	const parsed = await parseRawMime(parts.encode(parts.mixed(parts.text(large), parts.text("two"))));
	assert.equal(parsed.html, null);
	assert.ok(parsed.text.endsWith("<\ntwo"));
});

test("parts inside multipart/alternative do not count toward the limit", async () => {
	const large = "<".repeat(MAX_BODY_CONVERSION_COST / 6);
	const parsed = await parseRawMime(parts.encode(parts.alternative(parts.text(large), parts.html("<p>one</p>"))));
	assert.equal(parsed.html, "<p>one</p>");
	assert.equal(parsed.text.length, large.length);
});

test("characters that get replaced count nine times", async () => {
	const htmlCost = "<p>one</p>".length + 4 * 8;
	const available = MAX_BODY_CONVERSION_COST - htmlCost;
	const render = async (body) => parseRawMime(parts.encode(parts.mixed(parts.html("<p>one</p>"), parts.text(body))));
	const count = Math.floor(available / 9);
	for (const character of ["<", ">", '"', "'", "?", "&"]) {
		assert.notEqual((await render(character.repeat(count))).html, "<p>one</p>", character);
		assert.equal((await render(character.repeat(count + 1))).html, "<p>one</p>", character);
	}
	const brackets = Math.floor((available - 9_001) / 9);
	const withLines = (extra) =>
		`${"<".repeat(brackets)}${"x".repeat(available - 9_001 - 9 * brackets + extra)}${"\n".repeat(1_000)}y`;
	assert.notEqual((await render(withLines(0))).html, "<p>one</p>");
	assert.equal((await render(withLines(1))).html, "<p>one</p>");
});

test("in HTML, a run of spaces and tabs counts once and line ends count nine times", async () => {
	const render = async (body) => parseRawMime(parts.encode(parts.mixed(parts.text("hi"), parts.html(body))));
	const textCost = "hi".length;
	const available = MAX_BODY_CONVERSION_COST - textCost;
	const brackets = Math.floor((available - 8 - 1000) / 9);
	const withBlanks = (extra) =>
		`${">".repeat(brackets)}${"a".repeat(available - 8 - 1000 - 9 * brackets + extra)}${" \t".repeat(500)}`;
	assert.ok((await render(withBlanks(0))).text.length > 2);
	assert.equal((await render(withBlanks(1))).text, "hi");
	// A line separator also makes the part two bytes per character, so it counts ten times.
	for (const [character, cost] of [
		["\u2028", 10],
		["\u2029", 10],
		["\u0001", 9],
	]) {
		const count = Math.floor(available / cost);
		assert.ok((await render(character.repeat(count))).text.length >= 2, character);
		assert.equal((await render(character.repeat(count + 1))).text, "hi", character);
	}
});

test("in HTML, an entity counts 25 times its first character", async () => {
	const render = async (body) => parseRawMime(parts.encode(parts.mixed(parts.text("hi"), parts.html(body))));
	const available = MAX_BODY_CONVERSION_COST - "hi".length;
	const count = Math.floor(available / 25);
	assert.ok((await render("&".repeat(count))).text.length >= 2);
	assert.equal((await render("&".repeat(count + 1))).text, "hi");
	// Beside a text part, an ampersand in plain text only gets escaped.
	const plain = await parseRawMime(
		parts.encode(parts.mixed(parts.html("<p>one</p>"), parts.text("&".repeat(count + 1)))),
	);
	assert.notEqual(plain.html, "<p>one</p>");
});
